#!/usr/bin/env node
// Milestone 4 — offline routing-divergence report.
//
// Summarizes the resolver-vs-surface divergence telemetry recorded by the
// Chat Core v2 shadow route hook (contextPack.routingDivergence inside
// chat_v2_replay_bundles rows with id `chatv2-shadow-replay:%`).
//
// Read-only, fully offline: SELECTs from a local SQLite file, no network.
//
// Gate evidence is bound to an exact created_at window, telemetry versions,
// release identity, the observed manifest-routing capability-flag state, and
// one routing surface. Candidate identity comes only from the canonical
// NEXUS_RELEASE_* values embedded by the producer, and the flag state comes
// only from the state each producer observed while taking the comparison — a
// surface that was already consuming the manifest resolver would be agreeing
// with itself, so such bundles can never authorize its own flag.
//
// Usage:
//   node scripts/routing-divergence-report.mjs [--db path/to.db] [--json] [--top N]
//   node scripts/routing-divergence-report.mjs --gate --json \
//     --surface classifierKeyword \
//     --since 2026-07-31T12:00:00.000Z \
//     --until 2026-07-31T18:00:00.000Z \
//     --divergence-version routing_divergence_shadow@5.0.0 \
//     --resolver-version manifest-intent-resolver@1.0.0 \
//     --runtime-sha <40-hex-sha> \
//     --artifact-digest <64-hex-sha256> \
//     --environment staging \
//     --minimum-comparisons 200 \
//     --shadow-hook-receipt <server-transaction-receipt.json> \
//     --live-health <server-detailed-health.json> \
//     --synthetic-qa-manifest <owner-authorized-canonical-manifest.json> \
//     --expected-synthetic-qa-manifest-sha256 <sha256:64-lowercase-hex> \
//     --synthetic-qa-receipt <server-execution-receipt.json>
//
// --until pins the upper bound of the evidence window. Without it the window
// ends at report-generation time, so re-running the same command silently
// widens it; the emitted JSON always records which bound was evaluated.
//
// Defaults to DATABASE_PATH, then ./data/bot.db.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { validateShadowRouteHookReceipt } from './lib/chat-capability-flag-transaction.mjs';
import {
  ROUTING_SYNTHETIC_QA_CONTRACT_VERSION as SYNTHETIC_QA_CONTRACT_VERSION,
  ROUTING_SYNTHETIC_QA_QUOTAS,
  ROUTING_SYNTHETIC_QA_TRAFFIC_CLASS as SYNTHETIC_QA_TRAFFIC_CLASS,
  buildRoutingSyntheticQaManifest,
} from './lib/routing-synthetic-qa-manifest.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const readArg = (flag, fallback) => {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === flag) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        failUsage(`${flag} requires a value`);
      }
      values.push(value);
      index += 1;
    } else if (argument.startsWith(`${flag}=`)) {
      const value = argument.slice(flag.length + 1);
      if (!value) failUsage(`${flag} requires a value`);
      values.push(value);
    }
  }
  if (values.length > 1) failUsage(`${flag} may be supplied only once`);
  return values[0] ?? fallback;
};
const asJson = args.includes('--json');
const gateEnabled = args.includes('--gate');
const topN = Number.parseInt(readArg('--top', '15'), 10) || 15;
const dbPath = readArg('--db', process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'bot.db'));
const selectedSurface = readArg('--surface', undefined);
const sinceRaw = readArg('--since', undefined);
const untilRaw = readArg('--until', undefined);
const divergenceVersion = readArg('--divergence-version', undefined);
const resolverVersion = readArg('--resolver-version', undefined);
const runtimeSha = readArg('--runtime-sha', undefined);
const artifactDigest = readArg('--artifact-digest', undefined);
const environment = readArg('--environment', undefined);
const minimumComparisonsRaw = readArg('--minimum-comparisons', undefined);
const shadowHookReceiptPath = readArg('--shadow-hook-receipt', undefined);
const liveHealthPath = readArg('--live-health', undefined);
const syntheticQaManifestPath = readArg('--synthetic-qa-manifest', undefined);
const expectedSyntheticQaManifestSha256 = readArg(
  '--expected-synthetic-qa-manifest-sha256',
  undefined,
);
const syntheticQaReceiptPath = readArg('--synthetic-qa-receipt', undefined);
const MINIMUM_AGREEMENT_RATE = 0.99;
const SYNTHETIC_QA_PLANNED_TURNS = ROUTING_SYNTHETIC_QA_QUOTAS.plannedTurns;
const SYNTHETIC_QA_RECEIPT_SCHEMA = 'nexus.routing-synthetic-qa-receipt.v1';
const SYNTHETIC_QA_PROVENANCE_KEYS = Object.freeze([
  'contractVersion',
  'trafficClass',
  'manifestSha256',
  'surface',
  'ordinal',
  'plannedTurns',
  'turnId',
  'locale',
]);
const SYNTHETIC_QA_RECEIPT_KEYS = Object.freeze([
  'schema',
  'status',
  'contractVersion',
  'trafficClass',
  'manifestSha256',
  'runtimeSha',
  'artifactDigest',
  'environment',
  'surface',
  'userId',
  'tenantId',
  'plannedTurns',
  'attemptedTurns',
  'acceptedTurns',
  'recordedTurns',
  'startedAt',
  'completedAt',
  'httpStatusCounts',
  'apiUsageDelta',
  'providerReservationDelta',
  'providerCalled',
  'externalCallPerformed',
  'domainMutationPerformed',
]);
const TELEMETRY_IDENTIFIER = /^[a-zA-Z0-9@._:-]{1,128}$/;
const FULL_RUNTIME_SHA = /^[0-9a-f]{40}$/;
const FULL_ARTIFACT_DIGEST = /^[0-9a-f]{64}$/;
const RELEASE_IDENTITY_KEYS = Object.freeze(['runtimeSha', 'artifactDigest', 'role']);
const SURFACE_TO_FLAG = Object.freeze({
  classifierKeyword: 'AI_ROUTING_MANIFEST_CLASSIFIER',
  orchestratorPrimary: 'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  registrySubset: 'AI_ROUTING_MANIFEST_REGISTRY',
  shadowRoute: 'AI_ROUTING_MANIFEST_SHADOW',
});
const SURFACES = Object.freeze(Object.keys(SURFACE_TO_FLAG));
const MASTER_KILL_FLAG = 'AI_ROUTING_MANIFEST_KILL';
const CAPABILITY_FLAG_KEYS = Object.freeze([...SURFACES, 'masterKill']);
const RECORDER_STATE_KEYS = Object.freeze([
  'userId',
  'tenantId',
  'shadowRouteHookEffective',
  'shadowPlannerEffective',
]);
const REQUIRED_DIVERGENCE_VERSION = 'routing_divergence_shadow@5.0.0';

function failUsage(message) {
  console.error(`routing-divergence-report: ${message}`);
  process.exit(1);
}

function parseCanonicalTimestamp(flag, raw) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)
    || Number.isNaN(Date.parse(raw))
    || new Date(raw).toISOString() !== raw
  ) {
    failUsage(`${flag} must be a canonical UTC ISO timestamp with milliseconds`);
  }
  return raw;
}

function validateTelemetryIdentifier(flag, value) {
  if (!TELEMETRY_IDENTIFIER.test(value)) {
    failUsage(`${flag} must be an exact telemetry identifier`);
  }
}

function parsePositiveInteger(flag, raw) {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    failUsage(`${flag} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    failUsage(`${flag} must be a positive integer`);
  }
  return parsed;
}

function isStrictReleaseIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === RELEASE_IDENTITY_KEYS.length
    && keys.every((key) => RELEASE_IDENTITY_KEYS.includes(key))
    && typeof value.runtimeSha === 'string'
    && FULL_RUNTIME_SHA.test(value.runtimeSha)
    && typeof value.artifactDigest === 'string'
    && FULL_ARTIFACT_DIGEST.test(value.artifactDigest)
    && (value.role === 'staging' || value.role === 'production');
}

/**
 * The producer records the effective manifest-routing capability state it
 * observed for the comparison. Only an exact, fully populated boolean shape
 * counts: an absent, partial, or loosely typed state is an unknown flag state,
 * and an unknown flag state can never authorize a flip.
 */
function isStrictCapabilityFlagState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === CAPABILITY_FLAG_KEYS.length
    && keys.every((key) => CAPABILITY_FLAG_KEYS.includes(key))
    && CAPABILITY_FLAG_KEYS.every((key) => typeof value[key] === 'boolean');
}

function capabilityFlagStateKey(flags) {
  return CAPABILITY_FLAG_KEYS.map((key) => `${key}=${flags[key] ? 'on' : 'off'}`).join(',');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJsonEvidenceFile(flag, filePath) {
  if (!fs.existsSync(filePath)) failUsage(`${flag} file does not exist`);
  let raw;
  try {
    raw = fs.readFileSync(filePath);
  } catch {
    failUsage(`${flag} file could not be read`);
  }
  try {
    return { raw, value: JSON.parse(raw.toString('utf8')), sha256: sha256(raw) };
  } catch {
    failUsage(`${flag} must contain valid JSON`);
  }
}

function isExactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isCanonicalPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function syntheticQaTurnIdentity(manifestSha256, surface, ordinal) {
  return `${SYNTHETIC_QA_CONTRACT_VERSION}:${manifestSha256}:${surface}:${String(ordinal).padStart(3, '0')}`;
}

function hmacSyntheticQaValue(secret, userId, tenantId, kind, value) {
  return createHmac('sha256', secret)
    .update(`${tenantId}:${userId}:${kind}:${value}`)
    .digest('hex');
}

function validateSyntheticQaManifestEvidence(filePath, binding) {
  const parsed = readJsonEvidenceFile('--synthetic-qa-manifest', filePath);
  let built;
  try {
    built = buildRoutingSyntheticQaManifest(parsed.value, {
      expectedRuntimeSha: binding.runtimeSha,
      expectedArtifactDigest: binding.artifactDigest,
      expectedSurface: binding.surface,
      expectedDedicatedId: binding.dedicatedTenantId,
    });
  } catch (error) {
    failUsage(
      `synthetic QA manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const canonicalBytes = Buffer.from(built.bytes, 'utf8');
  if (!parsed.raw.equals(canonicalBytes)) {
    failUsage('synthetic QA manifest must use the exact canonical compact JSON bytes');
  }
  const secret = String(process.env.CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET ?? '').trim();
  if (!secret) {
    failUsage('CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET is required to verify synthetic QA evidence');
  }
  const manifestSha256 = parsed.sha256;
  const expectedTurns = new Map(built.manifest.turns.map((turn) => {
    const turnId = syntheticQaTurnIdentity(manifestSha256, built.manifest.surface, turn.ordinal);
    return [turn.ordinal, {
      ...turn,
      turnId,
      messageHash: hmacSyntheticQaValue(
        secret,
        built.manifest.userId,
        built.manifest.tenantId,
        'message',
        turn.text,
      ),
      clientMessageHash: hmacSyntheticQaValue(
        secret,
        built.manifest.userId,
        built.manifest.tenantId,
        'client_message_id',
        turnId,
      ),
    }];
  }));
  return {
    manifest: built.manifest,
    manifestSha256,
    manifestSha256Prefixed: `sha256:${manifestSha256}`,
    expectedTurns,
  };
}

function validateSyntheticQaReceiptEvidence(filePath, binding) {
  const parsed = readJsonEvidenceFile('--synthetic-qa-receipt', filePath);
  const receipt = parsed.value;
  if (!isExactObject(receipt, SYNTHETIC_QA_RECEIPT_KEYS)) {
    failUsage('synthetic QA receipt must have the exact governed shape');
  }
  if (receipt.schema !== SYNTHETIC_QA_RECEIPT_SCHEMA
      || receipt.status !== 'passed'
      || receipt.contractVersion !== SYNTHETIC_QA_CONTRACT_VERSION
      || receipt.trafficClass !== SYNTHETIC_QA_TRAFFIC_CLASS) {
    failUsage('synthetic QA receipt contract identity or terminal status is invalid');
  }
  if (receipt.manifestSha256 !== binding.manifestSha256Prefixed
      || receipt.runtimeSha !== binding.runtimeSha
      || receipt.artifactDigest !== binding.artifactDigest
      || receipt.environment !== 'staging'
      || receipt.environment !== binding.environment
      || receipt.surface !== binding.surface
      || receipt.userId !== binding.dedicatedTenantId
      || receipt.tenantId !== binding.dedicatedTenantId
      || receipt.userId !== receipt.tenantId) {
    failUsage('synthetic QA receipt manifest, release, surface, or identity binding is not exact');
  }
  if (receipt.plannedTurns !== SYNTHETIC_QA_PLANNED_TURNS
      || receipt.attemptedTurns !== SYNTHETIC_QA_PLANNED_TURNS
      || receipt.acceptedTurns !== SYNTHETIC_QA_PLANNED_TURNS
      || receipt.recordedTurns !== SYNTHETIC_QA_PLANNED_TURNS) {
    failUsage('synthetic QA receipt must attest exactly 200 attempted, accepted, and recorded turns');
  }
  const startedAt = parseCanonicalTimestamp('synthetic QA receipt startedAt', receipt.startedAt);
  const completedAt = parseCanonicalTimestamp('synthetic QA receipt completedAt', receipt.completedAt);
  if (startedAt !== binding.since || completedAt !== binding.until) {
    failUsage('synthetic QA receipt timestamps must equal the exact gate window');
  }
  if (!isExactObject(receipt.httpStatusCounts, ['200'])
      || receipt.httpStatusCounts['200'] !== SYNTHETIC_QA_PLANNED_TURNS) {
    failUsage('synthetic QA receipt must attest exactly 200 HTTP 200 responses');
  }
  for (const [name, delta] of [
    ['apiUsageDelta', receipt.apiUsageDelta],
    ['providerReservationDelta', receipt.providerReservationDelta],
  ]) {
    if (!isExactObject(delta, ['rows', 'costUsd'])
        || delta.rows !== 0
        || delta.costUsd !== 0) {
      failUsage(`synthetic QA receipt ${name} must attest zero rows and zero cost`);
    }
  }
  if (receipt.providerCalled !== false
      || receipt.externalCallPerformed !== false
      || receipt.domainMutationPerformed !== false) {
    failUsage('synthetic QA receipt must attest zero provider, external, and domain mutation activity');
  }
  return {
    receipt,
    sha256: parsed.sha256,
    sha256Prefixed: `sha256:${parsed.sha256}`,
  };
}

function validateShadowHookReceiptEvidence(filePath) {
  const parsed = readJsonEvidenceFile('--shadow-hook-receipt', filePath);
  let receipt;
  try {
    receipt = validateShadowRouteHookReceipt(parsed.value);
  } catch (error) {
    failUsage(`shadow hook receipt is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    receipt.role !== 'staging'
    || receipt.status !== 'passed'
    || receipt.action !== 'enable'
    || receipt.desiredValue !== true
    || receipt.transitionReason !== 'dedicated_eval_evidence_collection'
    || receipt.dedicatedIdentityAttested !== true
    || receipt.recorderAfter?.user !== true
    || receipt.recorderAfter?.tenant !== true
    || receipt.health?.backend !== 'passed'
    || receipt.health?.identity !== 'passed'
    || receipt.health?.shadowHook !== 'passed'
    || receipt.rollback?.status !== 'not_required'
  ) {
    failUsage('shadow hook receipt must be an exact passed staging enable transaction');
  }
  return { receipt, sha256: parsed.sha256 };
}

function validateLiveHealthEvidence(filePath) {
  const parsed = readJsonEvidenceFile('--live-health', filePath);
  const health = parsed.value;
  const attestation = health?.releaseAttestation;
  const hook = attestation?.shadowRouteHookEffective;
  const planner = attestation?.shadowPlannerEffective;
  const guard = attestation?.capabilityRuntimeGuard;
  const dedicatedHook = hook?.dedicatedEval;
  const dedicatedPlanner = planner?.dedicatedEval;
  const checkedAt = parseCanonicalTimestamp('live health timestamp', health?.timestamp);
  if (
    health?.status !== 'healthy'
    || health?.database !== 'connected'
    || attestation?.schema !== 'nexus.chat-capability-release-attestation.v2'
    || !isExactObject(guard, ['status', 'reason', 'transactionId', 'planDigest'])
    || guard?.status !== 'clear'
    || guard.reason !== 'no_unresolved_transaction'
    || guard.transactionId !== null
    || guard.planDigest !== null
    || !isExactObject(hook, ['global', 'dedicatedEval'])
    || !isExactObject(dedicatedHook, ['present', 'user', 'tenant'])
    || !isExactObject(planner, [
      'global',
      'user1000014',
      'tenant1000014',
      'user1000016',
      'tenant1000016',
      'dedicatedEval',
    ])
    || !isExactObject(dedicatedPlanner, ['present', 'user', 'tenant'])
    || hook.global !== false
    || dedicatedHook.present !== true
    || dedicatedHook.user !== true
    || dedicatedHook.tenant !== true
    || planner.global !== false
    || planner.user1000014 !== false
    || planner.tenant1000014 !== false
    || planner.user1000016 !== false
    || planner.tenant1000016 !== false
    || dedicatedPlanner.present !== true
    || dedicatedPlanner.user !== false
    || dedicatedPlanner.tenant !== false
  ) {
    failUsage('live health does not attest the exact healthy dedicated recorder state');
  }
  return { health, attestation, checkedAt, sha256: parsed.sha256 };
}

function isStrictRecorderStateShape(value) {
  if (!isExactObject(value, RECORDER_STATE_KEYS)) return false;
  const canonicalPositiveId = (candidate) => {
    if (typeof candidate !== 'string' || !/^[1-9][0-9]*$/u.test(candidate)) return false;
    const parsed = Number(candidate);
    return Number.isSafeInteger(parsed) && String(parsed) === candidate;
  };
  if (
    !canonicalPositiveId(value.userId)
    || !canonicalPositiveId(value.tenantId)
    || typeof value.shadowRouteHookEffective !== 'boolean'
    || typeof value.shadowPlannerEffective !== 'boolean'
  ) return false;
  return true;
}

function isStrictSyntheticQaTrafficProvenance(value) {
  return isExactObject(value, SYNTHETIC_QA_PROVENANCE_KEYS)
    && value.contractVersion === SYNTHETIC_QA_CONTRACT_VERSION
    && value.trafficClass === SYNTHETIC_QA_TRAFFIC_CLASS
    && typeof value.manifestSha256 === 'string'
    && /^sha256:[0-9a-f]{64}$/u.test(value.manifestSha256)
    && SURFACES.includes(value.surface)
    && isCanonicalPositiveInteger(value.ordinal)
    && value.ordinal <= SYNTHETIC_QA_PLANNED_TURNS
    && value.plannedTurns === SYNTHETIC_QA_PLANNED_TURNS
    && typeof value.turnId === 'string'
    && /^[a-zA-Z0-9@._:-]{1,256}$/u.test(value.turnId)
    && ['en-US', 'pt-BR', 'pt-PT'].includes(value.locale);
}

function classifyRecorderState(value, dedicatedId) {
  if (!isStrictRecorderStateShape(value)) return 'missing_or_malformed';
  const expectedId = String(dedicatedId);
  if (value.userId !== expectedId || value.tenantId !== expectedId) return 'dedicated_scope_mismatch';
  if (value.shadowRouteHookEffective !== true) return 'hook_not_effective';
  if (value.shadowPlannerEffective !== false) return 'planner_effective';
  return 'exact';
}

function isSafeIdentifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9@._:-]{1,128}$/u.test(value);
}

function isStrictDivergenceShape(value) {
  if (!isExactObject(value, [
    'divergenceVersion',
    'resolverVersion',
    'releaseIdentity',
    'capabilityFlags',
    'recorderState',
    'trafficProvenance',
    'topCandidate',
    'candidateCount',
    'surfaces',
    'agreement',
  ])) return false;
  if (!isSafeIdentifier(value.divergenceVersion) || !isSafeIdentifier(value.resolverVersion)) return false;
  if (!isStrictReleaseIdentity(value.releaseIdentity)) return false;
  if (!isStrictCapabilityFlagState(value.capabilityFlags)) return false;
  if (!isStrictRecorderStateShape(value.recorderState)) return false;
  if (!(value.trafficProvenance === null || isStrictSyntheticQaTrafficProvenance(value.trafficProvenance))) {
    return false;
  }
  if (!Number.isSafeInteger(value.candidateCount) || value.candidateCount < 0) return false;
  const top = value.topCandidate;
  if (top !== null) {
    if (!isExactObject(top, [
      'capabilityId', 'domain', 'skill', 'rawScore', 'matchedEvidenceCount',
    ])) return false;
    if (
      !isSafeIdentifier(top.capabilityId)
      || !isSafeIdentifier(top.domain)
      || !isSafeIdentifier(top.skill)
      || typeof top.rawScore !== 'number'
      || !Number.isFinite(top.rawScore)
      || !Number.isSafeInteger(top.matchedEvidenceCount)
      || top.matchedEvidenceCount < 0
    ) return false;
  }
  const surfaces = value.surfaces;
  if (!isExactObject(surfaces, [
    'classifierKeywordDomain',
    'orchestratorPrimaryDomain',
    'registryActionSkills',
    'shadowRouteIntent',
    'shadowRouteDomains',
  ])) return false;
  if (
    !(surfaces.classifierKeywordDomain === null || isSafeIdentifier(surfaces.classifierKeywordDomain))
    || !(surfaces.orchestratorPrimaryDomain === null || isSafeIdentifier(surfaces.orchestratorPrimaryDomain))
    || !Array.isArray(surfaces.registryActionSkills)
    || !surfaces.registryActionSkills.every(isSafeIdentifier)
    || !isSafeIdentifier(surfaces.shadowRouteIntent)
    || !Array.isArray(surfaces.shadowRouteDomains)
    || !surfaces.shadowRouteDomains.every(isSafeIdentifier)
  ) return false;
  const agreement = value.agreement;
  if (!isExactObject(agreement, SURFACES)) return false;
  return SURFACES.every((surface) => (
    agreement[surface] === null || typeof agreement[surface] === 'boolean'
  ));
}

if (gateEnabled && (
  !selectedSurface
  || !sinceRaw
  || !untilRaw
  || !divergenceVersion
  || !resolverVersion
  || !runtimeSha
  || !artifactDigest
  || !environment
  || !minimumComparisonsRaw
  || !shadowHookReceiptPath
  || !liveHealthPath
  || !syntheticQaManifestPath
  || !expectedSyntheticQaManifestSha256
  || !syntheticQaReceiptPath
)) {
  failUsage(
    '--gate requires explicit --surface, --since, --until, --divergence-version, --resolver-version, '
    + '--runtime-sha, --artifact-digest, --environment, --minimum-comparisons, '
    + '--shadow-hook-receipt, --live-health, --synthetic-qa-manifest, '
    + '--expected-synthetic-qa-manifest-sha256, and --synthetic-qa-receipt',
  );
}
// A gate run is a saved receipt (divergence-gate.json), so it must emit the
// machine-readable report rather than human-readable text under that filename.
if (gateEnabled && !asJson) {
  failUsage('--gate requires --json so the saved receipt is machine-readable');
}
if ((divergenceVersion === undefined) !== (resolverVersion === undefined)) {
  failUsage('--divergence-version and --resolver-version must be supplied together');
}
if ((shadowHookReceiptPath === undefined) !== (liveHealthPath === undefined)) {
  failUsage('--shadow-hook-receipt and --live-health must be supplied together');
}
const releaseIdentityValues = [runtimeSha, artifactDigest, environment];
if (
  releaseIdentityValues.some((value) => value !== undefined)
  && releaseIdentityValues.some((value) => value === undefined)
) {
  failUsage('--runtime-sha, --artifact-digest, and --environment must be supplied together');
}
const since = sinceRaw === undefined ? undefined : parseCanonicalTimestamp('--since', sinceRaw);
const until = untilRaw === undefined ? undefined : parseCanonicalTimestamp('--until', untilRaw);
if (since !== undefined && until !== undefined && Date.parse(until) < Date.parse(since)) {
  failUsage('--until must not be earlier than --since');
}
if (divergenceVersion !== undefined) {
  validateTelemetryIdentifier('--divergence-version', divergenceVersion);
  validateTelemetryIdentifier('--resolver-version', resolverVersion);
}
if (gateEnabled && divergenceVersion !== REQUIRED_DIVERGENCE_VERSION) {
  failUsage(`--gate requires --divergence-version ${REQUIRED_DIVERGENCE_VERSION}`);
}
if (selectedSurface !== undefined && !Object.hasOwn(SURFACE_TO_FLAG, selectedSurface)) {
  failUsage(`--surface must be one of: ${SURFACES.join(', ')}`);
}
if (runtimeSha !== undefined && !FULL_RUNTIME_SHA.test(runtimeSha)) {
  failUsage('--runtime-sha must be a full lowercase 40-hex SHA');
}
if (artifactDigest !== undefined && !FULL_ARTIFACT_DIGEST.test(artifactDigest)) {
  failUsage('--artifact-digest must be a full lowercase 64-hex SHA-256 digest');
}
if (
  expectedSyntheticQaManifestSha256 !== undefined
  && !/^sha256:[0-9a-f]{64}$/u.test(expectedSyntheticQaManifestSha256)
) {
  failUsage('--expected-synthetic-qa-manifest-sha256 must be sha256: plus 64 lowercase hex characters');
}
if (environment !== undefined && environment !== 'staging' && environment !== 'production') {
  failUsage('--environment must be staging or production');
}
if (gateEnabled && environment !== 'staging') {
  failUsage('--gate evidence must come from the staging environment');
}
const minimumComparisons = minimumComparisonsRaw === undefined
  ? undefined
  : parsePositiveInteger('--minimum-comparisons', minimumComparisonsRaw);
if (gateEnabled && minimumComparisons !== SYNTHETIC_QA_PLANNED_TURNS) {
  failUsage(`--gate requires --minimum-comparisons ${SYNTHETIC_QA_PLANNED_TURNS}`);
}
const shadowHookReceiptEvidence = gateEnabled
  ? validateShadowHookReceiptEvidence(shadowHookReceiptPath)
  : null;
const liveHealthEvidence = gateEnabled
  ? validateLiveHealthEvidence(liveHealthPath)
  : null;
const syntheticQaManifestEvidence = gateEnabled
  ? validateSyntheticQaManifestEvidence(syntheticQaManifestPath, {
    runtimeSha,
    artifactDigest,
    environment,
    surface: selectedSurface,
    dedicatedTenantId: shadowHookReceiptEvidence.receipt.dedicatedTenantId,
  })
  : null;
if (
  gateEnabled
  && syntheticQaManifestEvidence.manifestSha256Prefixed !== expectedSyntheticQaManifestSha256
) {
  failUsage('synthetic QA manifest bytes do not match the precommitted SHA-256 digest');
}
let syntheticQaReceiptEvidence = null;
if (gateEnabled) {
  const receipt = shadowHookReceiptEvidence.receipt;
  const attestation = liveHealthEvidence.attestation;
  if (
    receipt.runtimeSha !== runtimeSha
    || receipt.artifactDigest !== artifactDigest
    || receipt.role !== environment
    || attestation.runtimeSha !== runtimeSha
    || attestation.artifactDigest !== artifactDigest
    || attestation.role !== environment
  ) {
    failUsage('shadow hook receipt, live health, and requested release identity must match exactly');
  }
  if (Date.parse(since) < Date.parse(receipt.completedAt)) {
    failUsage('--since must be at or after shadow hook receipt completedAt');
  }
  if (Date.parse(liveHealthEvidence.checkedAt) < Date.parse(receipt.completedAt)) {
    failUsage('live health timestamp must be at or after shadow hook receipt completedAt');
  }
  syntheticQaReceiptEvidence = validateSyntheticQaReceiptEvidence(syntheticQaReceiptPath, {
    manifestSha256Prefixed: syntheticQaManifestEvidence.manifestSha256Prefixed,
    runtimeSha,
    artifactDigest,
    environment,
    surface: selectedSurface,
    dedicatedTenantId: shadowHookReceiptEvidence.receipt.dedicatedTenantId,
    since,
    until,
  });
}
const generatedAt = new Date().toISOString();
// Operator-pinnable upper bound: without --until the window ends at generation
// time, so the same command evaluates a wider window on every re-run.
const throughInclusive = until ?? generatedAt;
const windowUpperBoundSource = until === undefined ? 'report_generation_time' : 'until_flag';
// Any supplied identity input filters. Accepting the release identity while
// quietly comparing nothing would emit a report that claims a binding it never
// applied.
const identityFilterEnabled = divergenceVersion !== undefined || runtimeSha !== undefined;
const enforcedIdentityFields = [
  ...(divergenceVersion === undefined ? [] : ['divergenceVersion', 'resolverVersion']),
  ...(runtimeSha === undefined ? [] : ['runtimeSha', 'artifactDigest', 'role']),
];

if (!fs.existsSync(dbPath)) {
  console.error(`routing-divergence-report: database not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const tableExists = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_v2_replay_bundles'")
  .get();
if (!tableExists) {
  console.error('routing-divergence-report: chat_v2_replay_bundles table not present — no shadow telemetry yet');
  process.exit(1);
}

const rows = since === undefined
  ? db.prepare(`
    SELECT redacted_bundle_json, created_at
    FROM chat_v2_replay_bundles
    WHERE replay_bundle_id LIKE 'chatv2-shadow-replay:%'
      AND julianday(created_at) <= julianday(?)
    ORDER BY created_at ASC, id ASC
  `).all(throughInclusive)
  : db.prepare(`
    SELECT redacted_bundle_json, created_at
    FROM chat_v2_replay_bundles
    WHERE replay_bundle_id LIKE 'chatv2-shadow-replay:%'
      AND julianday(created_at) >= julianday(?)
      AND julianday(created_at) <= julianday(?)
    ORDER BY created_at ASC, id ASC
  `).all(since, throughInclusive);

let totalBundles = 0;
let withDivergence = 0;
let noTopCandidate = 0;
let invalidJsonBundles = 0;
let identityMatchedBundles = 0;
let identityMismatchBundles = 0;
let divergenceVersionMismatchBundles = 0;
let resolverVersionMismatchBundles = 0;
let runtimeShaMismatchBundles = 0;
let artifactDigestMismatchBundles = 0;
let environmentMismatchBundles = 0;
let releaseIdentityShapeMismatchBundles = 0;
let capabilityFlagStateBundles = 0;
let missingCapabilityFlagStateBundles = 0;
let selectedSurfaceFlagOnBundles = 0;
let masterKillEngagedBundles = 0;
let capabilityFlagIneligibleBundles = 0;
let capabilityFlagEligibleBundles = 0;
let exactRecorderStateBundles = 0;
let missingRecorderStateBundles = 0;
let dedicatedScopeMismatchBundles = 0;
let hookNotEffectiveBundles = 0;
let plannerEffectiveBundles = 0;
let malformedDivergenceBundles = 0;
let syntheticQaMatchedBundles = 0;
let syntheticQaMissingOrMalformedProvenanceBundles = 0;
let syntheticQaManifestMismatchBundles = 0;
let syntheticQaDuplicateOrdinalBundles = 0;
let syntheticQaHmacMismatchBundles = 0;
let syntheticQaExpectedLabelMismatchBundles = 0;
let syntheticQaTargetSurfaceNotComparedBundles = 0;
const syntheticQaSeenOrdinals = new Set();
// exact observed flag-state key -> count
const observedCapabilityFlagStates = new Map();
// surface -> skill -> { compared, agreed }
const agreementBySurfaceSkill = new Map();
// cluster key `surface|surfaceDecision|resolverDomain` -> count
const disagreementClusters = new Map();

for (const row of rows) {
  totalBundles += 1;
  let bundle;
  try {
    bundle = JSON.parse(row.redacted_bundle_json);
  } catch {
    invalidJsonBundles += 1;
    if (gateEnabled) syntheticQaMissingOrMalformedProvenanceBundles += 1;
    continue;
  }
  const divergence = bundle?.contextPack?.routingDivergence;
  if (!divergence) {
    if (gateEnabled) syntheticQaMissingOrMalformedProvenanceBundles += 1;
    continue;
  }
  withDivergence += 1;
  if (gateEnabled) {
    const provenance = divergence.trafficProvenance;
    if (!isStrictSyntheticQaTrafficProvenance(provenance)) {
      syntheticQaMissingOrMalformedProvenanceBundles += 1;
    } else {
      const expected = syntheticQaManifestEvidence.expectedTurns.get(provenance.ordinal);
      const expectedRecorderLocale = expected?.locale === 'en-US' ? 'en' : expected?.locale;
      const manifestMatches = Boolean(expected)
        && provenance.manifestSha256 === syntheticQaManifestEvidence.manifestSha256Prefixed
        && provenance.surface === selectedSurface
        && provenance.turnId === expected.turnId
        && provenance.locale === expected.locale
        && bundle?.contextPack?.locale === expectedRecorderLocale
        && bundle?.contextPack?.attachmentsCount === 0
        && bundle?.contextPack?.messageLength === expected.text.length;
      if (!manifestMatches) syntheticQaManifestMismatchBundles += 1;

      let ordinalUnique = false;
      if (manifestMatches) {
        if (syntheticQaSeenOrdinals.has(provenance.ordinal)) {
          syntheticQaDuplicateOrdinalBundles += 1;
        } else {
          syntheticQaSeenOrdinals.add(provenance.ordinal);
          ordinalUnique = true;
        }
      }

      const hmacMatches = Boolean(expected)
        && typeof bundle?.contextPack?.messageHash === 'string'
        && typeof bundle?.contextPack?.clientMessageHash === 'string'
        && bundle.contextPack.messageHash === expected.messageHash
        && bundle.contextPack.clientMessageHash === expected.clientMessageHash;
      if (!hmacMatches) syntheticQaHmacMismatchBundles += 1;

      const expectedLabelMatches = Boolean(expected)
        && divergence.topCandidate?.domain === expected.expectedDomain
        && divergence.topCandidate?.skill === expected.expectedResolverSkill;
      if (!expectedLabelMatches) syntheticQaExpectedLabelMismatchBundles += 1;

      const targetSurfaceCompared = typeof divergence.agreement?.[selectedSurface] === 'boolean';
      if (!targetSurfaceCompared) syntheticQaTargetSurfaceNotComparedBundles += 1;

      if (manifestMatches && ordinalUnique && hmacMatches
          && expectedLabelMatches && targetSurfaceCompared) {
        syntheticQaMatchedBundles += 1;
      }
    }
  }
  let recorderStateClass = null;
  let divergenceShapeKnown = true;
  if (gateEnabled) {
    recorderStateClass = classifyRecorderState(
      divergence.recorderState,
      shadowHookReceiptEvidence.receipt.dedicatedTenantId,
    );
    if (recorderStateClass === 'exact') exactRecorderStateBundles += 1;
    else if (recorderStateClass === 'missing_or_malformed') missingRecorderStateBundles += 1;
    else if (recorderStateClass === 'dedicated_scope_mismatch') dedicatedScopeMismatchBundles += 1;
    else if (recorderStateClass === 'hook_not_effective') hookNotEffectiveBundles += 1;
    else if (recorderStateClass === 'planner_effective') plannerEffectiveBundles += 1;
    if (!isStrictDivergenceShape(divergence)) {
      malformedDivergenceBundles += 1;
      divergenceShapeKnown = false;
    }
  }
  if (identityFilterEnabled) {
    const divergenceMatches = divergenceVersion === undefined
      || divergence.divergenceVersion === divergenceVersion;
    const resolverMatches = resolverVersion === undefined
      || divergence.resolverVersion === resolverVersion;
    const recordedReleaseIdentity = divergence.releaseIdentity;
    const releaseIdentityShapeMatches = runtimeSha === undefined
      || isStrictReleaseIdentity(recordedReleaseIdentity);
    const runtimeShaMatches = runtimeSha === undefined
      || recordedReleaseIdentity?.runtimeSha === runtimeSha;
    const artifactDigestMatches = artifactDigest === undefined
      || recordedReleaseIdentity?.artifactDigest === artifactDigest;
    const environmentMatches = environment === undefined
      || recordedReleaseIdentity?.role === environment;
    if (!divergenceMatches) divergenceVersionMismatchBundles += 1;
    if (!resolverMatches) resolverVersionMismatchBundles += 1;
    if (!runtimeShaMatches) runtimeShaMismatchBundles += 1;
    if (!artifactDigestMatches) artifactDigestMismatchBundles += 1;
    if (!environmentMatches) environmentMismatchBundles += 1;
    if (!releaseIdentityShapeMatches) releaseIdentityShapeMismatchBundles += 1;
    if (
      !divergenceMatches
      || !resolverMatches
      || !runtimeShaMatches
      || !artifactDigestMatches
      || !environmentMatches
      || !releaseIdentityShapeMatches
    ) {
      identityMismatchBundles += 1;
      continue;
    }
  }
  identityMatchedBundles += 1;

  // Capability-flag binding. Section 7.1 requires the evidence for a surface to
  // be collected while that surface's own flag is still OFF; a surface already
  // consuming the manifest resolver would be scored against itself. The master
  // kill is recorded separately because it can force every surface off, and
  // manufacturing flag-off evidence with it is explicitly disallowed.
  const recordedCapabilityFlags = divergence.capabilityFlags;
  const capabilityFlagStateKnown = isStrictCapabilityFlagState(recordedCapabilityFlags);
  if (!capabilityFlagStateKnown) {
    missingCapabilityFlagStateBundles += 1;
  } else {
    capabilityFlagStateBundles += 1;
    const stateKey = capabilityFlagStateKey(recordedCapabilityFlags);
    observedCapabilityFlagStates.set(
      stateKey,
      (observedCapabilityFlagStates.get(stateKey) ?? 0) + 1,
    );
    if (recordedCapabilityFlags.masterKill) masterKillEngagedBundles += 1;
    if (selectedSurface !== undefined && recordedCapabilityFlags[selectedSurface]) {
      selectedSurfaceFlagOnBundles += 1;
    }
  }
  if (gateEnabled) {
    if (!divergenceShapeKnown) continue;
    const flagEligible = capabilityFlagStateKnown
      && !recordedCapabilityFlags.masterKill
      && !recordedCapabilityFlags[selectedSurface];
    if (!flagEligible) {
      capabilityFlagIneligibleBundles += 1;
      continue;
    }
    capabilityFlagEligibleBundles += 1;
    if (recorderStateClass !== 'exact') continue;
  }

  const top = divergence.topCandidate;
  if (!top) {
    noTopCandidate += 1;
    continue;
  }
  const surfaces = divergence.surfaces ?? {};
  const surfaceDecision = {
    classifierKeyword: surfaces.classifierKeywordDomain ?? null,
    orchestratorPrimary: surfaces.orchestratorPrimaryDomain ?? null,
    registrySubset: Array.isArray(surfaces.registryActionSkills) && surfaces.registryActionSkills.length > 0
      ? surfaces.registryActionSkills.join('+')
      : null,
    shadowRoute: Array.isArray(surfaces.shadowRouteDomains) && surfaces.shadowRouteDomains.length > 0
      ? surfaces.shadowRouteDomains.join('+')
      : null,
  };
  for (const surface of SURFACES) {
    const verdict = divergence.agreement?.[surface];
    if (verdict === null || verdict === undefined) continue; // surface had no decision
    if (!agreementBySurfaceSkill.has(surface)) agreementBySurfaceSkill.set(surface, new Map());
    const bySkill = agreementBySurfaceSkill.get(surface);
    if (!bySkill.has(top.skill)) bySkill.set(top.skill, { compared: 0, agreed: 0 });
    const bucket = bySkill.get(top.skill);
    bucket.compared += 1;
    if (verdict === true) bucket.agreed += 1;
    else {
      const key = `${surface}|${surfaceDecision[surface] ?? 'none'}|${top.domain}`;
      disagreementClusters.set(key, (disagreementClusters.get(key) ?? 0) + 1);
    }
  }
}

const surfaceTotals = Object.fromEntries(
  SURFACES.map((surface) => {
    const totals = [...(agreementBySurfaceSkill.get(surface)?.values() ?? [])]
      .reduce(
        (aggregate, bucket) => ({
          compared: aggregate.compared + bucket.compared,
          agreed: aggregate.agreed + bucket.agreed,
        }),
        { compared: 0, agreed: 0 },
      );
    return [surface, {
      ...totals,
      agreementRate: totals.compared > 0
        ? Number((totals.agreed / totals.compared).toFixed(4))
        : null,
    }];
  }),
);

const syntheticQaMissingOrdinals = gateEnabled
  ? SYNTHETIC_QA_PLANNED_TURNS - syntheticQaSeenOrdinals.size
  : 0;

const gateFailures = gateEnabled
  ? [
    ...(totalBundles !== SYNTHETIC_QA_PLANNED_TURNS
      ? [{
        scope: 'synthetic_qa',
        reason: 'in_window_bundle_count_mismatch',
        expectedBundles: SYNTHETIC_QA_PLANNED_TURNS,
        actualBundles: totalBundles,
      }]
      : []),
    ...(syntheticQaMissingOrMalformedProvenanceBundles > 0
      ? [{
        scope: 'synthetic_qa',
        reason: 'missing_or_malformed_traffic_provenance',
        bundles: syntheticQaMissingOrMalformedProvenanceBundles,
      }]
      : []),
    ...(syntheticQaManifestMismatchBundles > 0
      ? [{
        scope: 'synthetic_qa',
        reason: 'manifest_binding_mismatch',
        bundles: syntheticQaManifestMismatchBundles,
      }]
      : []),
    ...(syntheticQaDuplicateOrdinalBundles > 0
      ? [{
        scope: 'synthetic_qa',
        reason: 'duplicate_campaign_ordinal',
        bundles: syntheticQaDuplicateOrdinalBundles,
      }]
      : []),
    ...(syntheticQaMissingOrdinals > 0
      ? [{
        scope: 'synthetic_qa',
        reason: 'missing_campaign_ordinals',
        ordinals: syntheticQaMissingOrdinals,
      }]
      : []),
    ...(syntheticQaHmacMismatchBundles > 0
      ? [{
        scope: 'synthetic_qa',
        reason: 'message_or_client_hmac_mismatch',
        bundles: syntheticQaHmacMismatchBundles,
      }]
      : []),
    ...(syntheticQaExpectedLabelMismatchBundles > 0
      ? [{
        scope: 'synthetic_qa',
        reason: 'independent_expected_label_mismatch',
        bundles: syntheticQaExpectedLabelMismatchBundles,
      }]
      : []),
    ...(syntheticQaTargetSurfaceNotComparedBundles > 0
      ? [{
        scope: 'synthetic_qa',
        reason: 'target_surface_comparison_missing',
        bundles: syntheticQaTargetSurfaceNotComparedBundles,
      }]
      : []),
    ...(syntheticQaMatchedBundles !== SYNTHETIC_QA_PLANNED_TURNS
      ? [{
        scope: 'synthetic_qa',
        reason: 'one_to_one_campaign_binding_incomplete',
        expectedBundles: SYNTHETIC_QA_PLANNED_TURNS,
        matchedBundles: syntheticQaMatchedBundles,
      }]
      : []),
    ...(invalidJsonBundles > 0
      ? [{ scope: 'evidence', reason: 'malformed_bundle_json', bundles: invalidJsonBundles }]
      : []),
    ...((totalBundles - invalidJsonBundles - withDivergence) > 0
      ? [{
        scope: 'evidence',
        reason: 'missing_divergence_telemetry',
        bundles: totalBundles - invalidJsonBundles - withDivergence,
      }]
      : []),
    ...(identityMismatchBundles > 0
      ? [{ scope: 'evidence', reason: 'mixed_evidence_identity', bundles: identityMismatchBundles }]
      : []),
    ...(malformedDivergenceBundles > 0
      ? [{
        scope: 'evidence',
        reason: 'malformed_divergence_telemetry',
        bundles: malformedDivergenceBundles,
      }]
      : []),
    ...(identityMatchedBundles === 0
      ? [{ scope: 'evidence', reason: 'zero_identity_matched_bundles', matchedBundles: 0 }]
      : []),
    ...(missingCapabilityFlagStateBundles > 0
      ? [{
        scope: 'capability_flags',
        reason: 'unknown_capability_flag_state',
        bundles: missingCapabilityFlagStateBundles,
      }]
      : []),
    ...(selectedSurfaceFlagOnBundles > 0
      ? [{
        scope: 'capability_flags',
        reason: 'selected_surface_flag_already_enabled',
        surface: selectedSurface,
        capabilityFlag: SURFACE_TO_FLAG[selectedSurface],
        bundles: selectedSurfaceFlagOnBundles,
      }]
      : []),
    ...(masterKillEngagedBundles > 0
      ? [{
        scope: 'capability_flags',
        reason: 'master_kill_engaged',
        capabilityFlag: MASTER_KILL_FLAG,
        bundles: masterKillEngagedBundles,
      }]
      : []),
    ...(missingRecorderStateBundles > 0
      ? [{
        scope: 'shadow_recorder',
        reason: 'missing_or_malformed_recorder_state',
        bundles: missingRecorderStateBundles,
      }]
      : []),
    ...(dedicatedScopeMismatchBundles > 0
      ? [{
        scope: 'shadow_recorder',
        reason: 'dedicated_scope_mismatch',
        bundles: dedicatedScopeMismatchBundles,
      }]
      : []),
    ...(hookNotEffectiveBundles > 0
      ? [{
        scope: 'shadow_recorder',
        reason: 'shadow_route_hook_not_effective',
        bundles: hookNotEffectiveBundles,
      }]
      : []),
    ...(plannerEffectiveBundles > 0
      ? [{
        scope: 'shadow_recorder',
        reason: 'shadow_planner_effective',
        bundles: plannerEffectiveBundles,
      }]
      : []),
    ...(exactRecorderStateBundles !== capabilityFlagEligibleBundles
      ? [{
        scope: 'shadow_recorder',
        reason: 'recorder_state_count_does_not_match_eligible_bundles',
        exactRecorderStateBundles,
        eligibleBundles: capabilityFlagEligibleBundles,
      }]
      : []),
    ...(identityMatchedBundles > 0 && capabilityFlagEligibleBundles === 0
      ? [{ scope: 'evidence', reason: 'zero_flag_eligible_bundles', eligibleBundles: 0 }]
      : []),
    ...(() => {
      const totals = surfaceTotals[selectedSurface];
      if (totals.compared < minimumComparisons) {
        return [{
          surface: selectedSurface,
          reason: 'insufficient_comparisons',
          minimumComparisons,
          ...totals,
        }];
      }
      if ((totals.agreed / totals.compared) < MINIMUM_AGREEMENT_RATE) {
        return [{ surface: selectedSurface, reason: 'agreement_below_threshold', ...totals }];
      }
      return [];
    })(),
  ]
  : [];

const report = {
  generatedAt,
  dbPath,
  evidence: {
    identity: {
      divergenceVersion: divergenceVersion ?? null,
      resolverVersion: resolverVersion ?? null,
      releaseIdentity: runtimeSha === undefined
        ? null
        : { runtimeSha, artifactDigest, role: environment },
      enforced: identityFilterEnabled,
      enforcedFields: enforcedIdentityFields,
    },
    window: {
      sinceInclusive: since ?? null,
      throughInclusive,
      untilInclusive: until ?? null,
      upperBoundSource: windowUpperBoundSource,
      timestampColumn: 'chat_v2_replay_bundles.created_at',
      comparison: 'SQLite julianday normalization, inclusive bounds',
    },
    counts: {
      shadowBundlesInWindow: totalBundles,
      validJsonBundles: totalBundles - invalidJsonBundles,
      invalidJsonBundles,
      divergenceTelemetryBundles: withDivergence,
      withoutDivergenceTelemetryBundles: totalBundles - invalidJsonBundles - withDivergence,
      identityMatchedBundles,
      identityMismatchBundles,
      divergenceVersionMismatchBundles,
      resolverVersionMismatchBundles,
      runtimeShaMismatchBundles,
      artifactDigestMismatchBundles,
      environmentMismatchBundles,
      releaseIdentityShapeMismatchBundles,
      malformedDivergenceBundles,
    },
    runtimeArtifactBinding: {
      available: runtimeSha !== undefined,
      enforced: runtimeSha !== undefined,
    },
    capabilityFlagBinding: {
      enforced: gateEnabled,
      selectedSurface: selectedSurface ?? null,
      selectedSurfaceFlag: selectedSurface === undefined
        ? null
        : SURFACE_TO_FLAG[selectedSurface],
      masterKillFlag: MASTER_KILL_FLAG,
      counts: {
        knownFlagStateBundles: capabilityFlagStateBundles,
        unknownFlagStateBundles: missingCapabilityFlagStateBundles,
        selectedSurfaceFlagOnBundles,
        masterKillEngagedBundles,
        flagEligibleBundles: capabilityFlagEligibleBundles,
        flagIneligibleBundles: capabilityFlagIneligibleBundles,
      },
      observedStates: [...observedCapabilityFlagStates.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([state, bundles]) => ({ state, bundles })),
    },
    ...(gateEnabled ? {
      syntheticQaBinding: {
        enforced: true,
        contractVersion: SYNTHETIC_QA_CONTRACT_VERSION,
        trafficClass: SYNTHETIC_QA_TRAFFIC_CLASS,
        manifest: {
          schema: syntheticQaManifestEvidence.manifest.schema,
          sha256: syntheticQaManifestEvidence.manifestSha256Prefixed,
          runtimeSha: syntheticQaManifestEvidence.manifest.runtimeSha,
          artifactDigest: syntheticQaManifestEvidence.manifest.artifactDigest,
          environment: syntheticQaManifestEvidence.manifest.environment,
          surface: syntheticQaManifestEvidence.manifest.surface,
          userId: syntheticQaManifestEvidence.manifest.userId,
          tenantId: syntheticQaManifestEvidence.manifest.tenantId,
          plannedTurns: syntheticQaManifestEvidence.manifest.plannedTurns,
        },
        receipt: {
          schema: syntheticQaReceiptEvidence.receipt.schema,
          sha256: syntheticQaReceiptEvidence.sha256Prefixed,
          status: syntheticQaReceiptEvidence.receipt.status,
          manifestSha256: syntheticQaReceiptEvidence.receipt.manifestSha256,
          runtimeSha: syntheticQaReceiptEvidence.receipt.runtimeSha,
          artifactDigest: syntheticQaReceiptEvidence.receipt.artifactDigest,
          environment: syntheticQaReceiptEvidence.receipt.environment,
          surface: syntheticQaReceiptEvidence.receipt.surface,
          userId: syntheticQaReceiptEvidence.receipt.userId,
          tenantId: syntheticQaReceiptEvidence.receipt.tenantId,
          plannedTurns: syntheticQaReceiptEvidence.receipt.plannedTurns,
          attemptedTurns: syntheticQaReceiptEvidence.receipt.attemptedTurns,
          acceptedTurns: syntheticQaReceiptEvidence.receipt.acceptedTurns,
          recordedTurns: syntheticQaReceiptEvidence.receipt.recordedTurns,
          startedAt: syntheticQaReceiptEvidence.receipt.startedAt,
          completedAt: syntheticQaReceiptEvidence.receipt.completedAt,
          httpStatusCounts: syntheticQaReceiptEvidence.receipt.httpStatusCounts,
          apiUsageDelta: syntheticQaReceiptEvidence.receipt.apiUsageDelta,
          providerReservationDelta: syntheticQaReceiptEvidence.receipt.providerReservationDelta,
          providerCalled: syntheticQaReceiptEvidence.receipt.providerCalled,
          externalCallPerformed: syntheticQaReceiptEvidence.receipt.externalCallPerformed,
          domainMutationPerformed: syntheticQaReceiptEvidence.receipt.domainMutationPerformed,
        },
        counts: {
          inWindowBundles: totalBundles,
          matchedBundles: syntheticQaMatchedBundles,
          missingOrMalformedProvenanceBundles: syntheticQaMissingOrMalformedProvenanceBundles,
          manifestMismatchBundles: syntheticQaManifestMismatchBundles,
          duplicateOrdinalBundles: syntheticQaDuplicateOrdinalBundles,
          missingOrdinals: syntheticQaMissingOrdinals,
          hmacMismatchBundles: syntheticQaHmacMismatchBundles,
          expectedLabelMismatchBundles: syntheticQaExpectedLabelMismatchBundles,
          targetSurfaceNotComparedBundles: syntheticQaTargetSurfaceNotComparedBundles,
        },
      },
      shadowRecorderBinding: {
        enforced: true,
        receipt: {
          schema: shadowHookReceiptEvidence.receipt.schema,
          sha256: shadowHookReceiptEvidence.sha256,
          transactionId: shadowHookReceiptEvidence.receipt.transactionId,
          planDigest: shadowHookReceiptEvidence.receipt.planDigest,
          planSequence: shadowHookReceiptEvidence.receipt.planSequence,
          completedAt: shadowHookReceiptEvidence.receipt.completedAt,
          runtimeSha: shadowHookReceiptEvidence.receipt.runtimeSha,
          artifactDigest: shadowHookReceiptEvidence.receipt.artifactDigest,
          role: shadowHookReceiptEvidence.receipt.role,
          status: shadowHookReceiptEvidence.receipt.status,
          action: shadowHookReceiptEvidence.receipt.action,
          dedicatedTenantId: shadowHookReceiptEvidence.receipt.dedicatedTenantId,
        },
        liveHealth: {
          sha256: liveHealthEvidence.sha256,
          checkedAt: liveHealthEvidence.checkedAt,
          shadowRouteHookGlobal: liveHealthEvidence.attestation.shadowRouteHookEffective.global,
          shadowRouteHookDedicatedUser:
            liveHealthEvidence.attestation.shadowRouteHookEffective.dedicatedEval.user,
          shadowRouteHookDedicatedTenant:
            liveHealthEvidence.attestation.shadowRouteHookEffective.dedicatedEval.tenant,
          shadowPlannerGlobal: liveHealthEvidence.attestation.shadowPlannerEffective.global,
          shadowPlannerDedicatedUser:
            liveHealthEvidence.attestation.shadowPlannerEffective.dedicatedEval.user,
          shadowPlannerDedicatedTenant:
            liveHealthEvidence.attestation.shadowPlannerEffective.dedicatedEval.tenant,
        },
        requiredState: {
          shadowRouteHookEffective: true,
          shadowPlannerEffective: false,
        },
        counts: {
          exactRecorderStateBundles,
          missingRecorderStateBundles,
          dedicatedScopeMismatchBundles,
          hookNotEffectiveBundles,
          plannerEffectiveBundles,
        },
      },
    } : {}),
  },
  totalShadowBundles: totalBundles,
  bundlesWithDivergenceTelemetry: withDivergence,
  bundlesWithoutResolverCandidate: noTopCandidate,
  surfaceFlags: SURFACE_TO_FLAG,
  surfaceTotals,
  agreement: Object.fromEntries(
    [...agreementBySurfaceSkill.entries()].map(([surface, bySkill]) => [
      surface,
      Object.fromEntries(
        [...bySkill.entries()]
          .sort((a, b) => b[1].compared - a[1].compared)
          .map(([skill, { compared, agreed }]) => [
            skill,
            { compared, agreed, agreementRate: compared > 0 ? Number((agreed / compared).toFixed(4)) : null },
          ]),
      ),
    ]),
  ),
  topDisagreementClusters: [...disagreementClusters.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key, count]) => {
      const [surface, surfaceDecision, resolverDomain] = key.split('|');
      return { surface, surfaceDecision, resolverDomain, count };
    }),
  ...(gateEnabled ? {
    gate: {
      enabled: true,
      selectedSurface,
      capabilityFlag: SURFACE_TO_FLAG[selectedSurface],
      minimumComparisons,
      minimumAgreementRate: MINIMUM_AGREEMENT_RATE,
      passed: gateFailures.length === 0,
      failures: gateFailures,
    },
  } : {}),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Routing divergence report — ${report.generatedAt}`);
  console.log(`DB: ${report.dbPath}`);
  console.log(
    `Evidence window: ${report.evidence.window.sinceInclusive ?? 'unbounded'} through `
    + `${report.evidence.window.throughInclusive} (${report.evidence.window.upperBoundSource})`,
  );
  console.log(`Evidence versions: divergence=${report.evidence.identity.divergenceVersion ?? 'unbound'} resolver=${report.evidence.identity.resolverVersion ?? 'unbound'}`);
  const boundReleaseIdentity = report.evidence.identity.releaseIdentity;
  console.log(
    `Evidence release: ${boundReleaseIdentity
      ? `${boundReleaseIdentity.runtimeSha}:${boundReleaseIdentity.artifactDigest} (${boundReleaseIdentity.role})`
      : 'unbound'}`,
  );
  console.log(
    `Evidence identity: enforced=${report.evidence.identity.enforced} `
    + `matched=${report.evidence.counts.identityMatchedBundles} `
    + `mismatched=${report.evidence.counts.identityMismatchBundles}`,
  );
  const flagBinding = report.evidence.capabilityFlagBinding;
  console.log(
    `Evidence capability flags: enforced=${flagBinding.enforced} `
    + `known=${flagBinding.counts.knownFlagStateBundles} `
    + `unknown=${flagBinding.counts.unknownFlagStateBundles} `
    + `selectedSurfaceOn=${flagBinding.counts.selectedSurfaceFlagOnBundles} `
    + `masterKill=${flagBinding.counts.masterKillEngagedBundles}`,
  );
  for (const observed of flagBinding.observedStates) {
    console.log(`  observed ${observed.state} bundles=${observed.bundles}`);
  }
  console.log(`Shadow bundles: ${report.totalShadowBundles} (with divergence telemetry: ${report.bundlesWithDivergenceTelemetry}, no resolver candidate: ${report.bundlesWithoutResolverCandidate})`);
  console.log('\nSurface aggregate agreement:');
  for (const [surface, stats] of Object.entries(report.surfaceTotals)) {
    const pct = stats.agreementRate === null ? 'n/a' : `${(stats.agreementRate * 100).toFixed(1)}%`;
    console.log(`  ${surface.padEnd(20)} compared=${String(stats.compared).padStart(5)} agreed=${String(stats.agreed).padStart(5)} rate=${pct}`);
  }
  for (const [surface, bySkill] of Object.entries(report.agreement)) {
    console.log(`\nSurface: ${surface}`);
    for (const [skill, stats] of Object.entries(bySkill)) {
      const pct = stats.agreementRate === null ? 'n/a' : `${(stats.agreementRate * 100).toFixed(1)}%`;
      console.log(`  ${skill.padEnd(18)} compared=${String(stats.compared).padStart(5)} agreed=${String(stats.agreed).padStart(5)} rate=${pct}`);
    }
  }
  console.log('\nTop disagreement clusters (surface decision vs resolver domain):');
  if (report.topDisagreementClusters.length === 0) console.log('  none recorded');
  for (const cluster of report.topDisagreementClusters) {
    console.log(`  [${cluster.surface}] surface=${cluster.surfaceDecision} resolver=${cluster.resolverDomain} count=${cluster.count}`);
  }
  // No gate summary here: --gate always emits the JSON receipt instead.
}

db.close();

if (gateEnabled && gateFailures.length > 0) {
  console.error(`routing-divergence-report: gate failed with ${gateFailures.length} finding(s)`);
  process.exitCode = 1;
}
