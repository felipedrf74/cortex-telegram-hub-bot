#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Private, write-once pre-release economics evidence (hybrid AI plan §4).
//
// Usage:
//   node scripts/economics-simulation.mjs \
//     --rates <private-rate-card.json> \
//     --acceptance-evidence <private-ten-script-evidence.json> \
//     --workload-release-view <private-workload-release-state-view.json> \
//     --release-view <private-release-state-view.json> \
//     --workload-source-sha <40-lowercase-hex> \
//     --producer-source-sha <40-lowercase-hex> \
//     [--producer-source-repository <git-checkout>] \
//     --output <new-private-economics-artifact.json>

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './lib/release-canonical.mjs';
import { buildEconomicsActivationAuthentication } from './lib/economics-activation-auth.mjs';
import {
  CONTENT_TEN_SCRIPT_EVIDENCE_SCHEMA,
  CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES,
  CONTENT_TEN_SCRIPT_QUALITY_REVIEW_SCHEMA,
  CONTENT_SCRIPT_RUNTIME_RELEASE_SCHEMA,
  EXPECTED_SCRIPT_MODEL,
  EXPECTED_SCRIPT_PROVIDER,
  OPERATION_USAGE_CLASSIFICATION_VERSION,
  OPERATION_USAGE_EVIDENCE_SCHEMA,
  acceptanceSourceBindingSha256,
  atomicPrivateWrite,
  parsePrivateJson,
  resolveImmutableToolSourceBinding,
  sha256,
  validateCompletedReleaseView,
  validateImmutableToolSourceBinding,
} from './content-ten-script-evidence.mjs';
import {
  TEN_SCRIPT_ACCEPTANCE_REVISION,
  TEN_SCRIPT_ACCEPTANCE_SCENARIOS,
} from './content-ten-script-acceptance.mjs';

export const ECONOMICS_ARTIFACT_SCHEMA = 'nexus.pre-release-economics.v7';
export const ECONOMICS_SOURCE_BINDING_SCHEMA = 'nexus.economics-source-binding.v1';
export const ECONOMICS_PRODUCER_MODULES = Object.freeze([
  ...CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES,
  'scripts/economics-activation-verifier.mjs',
  'scripts/economics-simulation.mjs',
  'scripts/lib/economics-activation-auth.mjs',
  'scripts/lib/release-canonical.mjs',
]);
const ACCEPTANCE_EVIDENCE_ENTRYPOINT = 'scripts/content-ten-script-evidence.mjs';
const ECONOMICS_ENTRYPOINT = 'scripts/economics-simulation.mjs';

export const REQUIRED_RATE_FIELDS = [
  'version',
  'capturedAt',
  'providerRatesUsdPerMTok.standardOp.input',
  'providerRatesUsdPerMTok.standardOp.output',
  'providerRatesUsdPerMTok.deepOp.input',
  'providerRatesUsdPerMTok.deepOp.output',
  'providerRatesUsdPerMTok.standardScript.input',
  'providerRatesUsdPerMTok.standardScript.output',
  'providerRatesUsdPerMTok.scheduledScript.input',
  'providerRatesUsdPerMTok.scheduledScript.output',
  'providerRatesUsdPerMTok.priorityScript.input',
  'providerRatesUsdPerMTok.priorityScript.output',
  'stripeFeePct',
  'stripeFeeFixedUsd',
  'appleProceedsPct',
  'vpsAllocationUsdPerPaidUser',
  'refundsPct',
  'taxesPct',
  'projectedCohortCounts.pro_script_heavy.web',
  'projectedCohortCounts.pro_script_heavy.apple',
  'projectedCohortCounts.max_script_heavy.web',
  'projectedCohortCounts.max_script_heavy.apple',
  'projectedCohortCounts.chat_heavy.web',
  'projectedCohortCounts.chat_heavy.apple',
  'projectedCohortCounts.reasoning_heavy.web',
  'projectedCohortCounts.reasoning_heavy.apple',
  'projectedCohortCounts.priority_pack_buyer.web',
  'projectedCohortCounts.priority_pack_buyer.apple',
];

const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const RELEASE_ID = /^[0-9a-f]{32}$/u;
const JOB_ID = /^script_job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const RATE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
export const RATE_CARD_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const SCRIPT_CLASSES = Object.freeze({
  standardScript: 'standard',
  scheduledScript: 'scheduled',
  priorityScript: 'priority',
});
const DELIVERY_SAMPLE_COUNTS = Object.freeze({ standard: 4, scheduled: 3, priority: 3 });
const PLAN_PRICES_USD = Object.freeze({ pro: 9.99, max: 14.99 });
const PACK_600_PRICE_USD = 19.99;
const PROFILE_IDS = Object.freeze([
  'pro_script_heavy',
  'max_script_heavy',
  'chat_heavy',
  'reasoning_heavy',
  'priority_pack_buyer',
]);
const CHANNELS = Object.freeze(['web', 'apple']);
const EVIDENCE_TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion', 'acceptanceRevision', 'generatedAt', 'workloadSourceSha',
  'producerSourceSha', 'producerToolSource', 'sourceBindingSha256', 'stateSha256', 'scopeSha256',
  'workloadRelease', 'productionSmokeRuntimeRelease', 'qualityReview', 'release',
  'acceptancePass', 'inventory', 'p95Tokens',
  'p95ByDeliveryMode', 'operationUsage', 'totalModelCostUsd', 'totalToolCostUsd',
  'scripts',
]);

function refuse(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

export function safeEconomicsCliFailureMessage(error) {
  if (Number.isInteger(error?.exitCode) && typeof error?.message === 'string') {
    return error.message;
  }
  return error instanceof Error ? error.name : typeof error;
}

function readPath(object, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => (value == null ? value : value[key]), object);
}

function assertExactKeys(value, expected, label, { optional = [] } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value).filter((key) => !optional.includes(key)).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())
      || Object.keys(value).some((key) => !expected.includes(key) && !optional.includes(key))) {
    throw new Error(`${label} fields do not match the governed schema`);
  }
  return value;
}

function assertFiniteRange(value, label, minimum, maximum, { integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)
      || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${label} must be a finite${integer ? ' safe integer' : ''} value between ${minimum} and ${maximum}`);
  }
  return value;
}

function assertCanonicalTimestamp(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  const normalized = typeof value === 'string' && !value.includes('.')
    ? value.replace(/Z$/u, '.000Z') : value;
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)
      || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase sha256 digest`);
  }
  return value;
}

export function economicsSourceBindingSha256({
  workloadSourceSha,
  producerSourceSha,
  acceptanceSourceBindingSha256: acceptanceBinding,
  economicsToolBindingSha256,
}) {
  if (!FULL_SHA.test(workloadSourceSha ?? '') || !FULL_SHA.test(producerSourceSha ?? '')
      || workloadSourceSha === producerSourceSha
      || !SHA256.test(acceptanceBinding ?? '') || !SHA256.test(economicsToolBindingSha256 ?? '')) {
    throw new Error('economics source binding requires distinct commits and both immutable producer bindings');
  }
  return sha256(Buffer.from(
    `${ECONOMICS_SOURCE_BINDING_SCHEMA}\n${workloadSourceSha}\n${producerSourceSha}\n${acceptanceBinding}\n${economicsToolBindingSha256}\n`,
  ));
}

function assertJsonBytesMatch(value, bytes, label) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} bytes are not valid JSON`);
  }
  if (canonicalJson(parsed) !== canonicalJson(value)) {
    throw new Error(`${label} bytes do not match the validated object`);
  }
}

/** Fail closed on missing, nonnumeric, nonfinite, or out-of-range values. */
export function validateRateCard(rates) {
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
    throw new Error('rate card must be an object');
  }
  const missing = REQUIRED_RATE_FIELDS.filter((field) => {
    const value = readPath(rates, field);
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) {
    throw new Error(`rate card is incomplete (actual account rates required): ${missing.join(', ')}`);
  }
  assertExactKeys(rates, [
    'version', 'capturedAt', 'providerRatesUsdPerMTok', 'stripeFeePct',
    'stripeFeeFixedUsd', 'appleProceedsPct', 'vpsAllocationUsdPerPaidUser',
    'refundsPct', 'taxesPct', 'projectedCohortCounts',
  ], 'rate card', { optional: ['_comment'] });
  assertExactKeys(rates.providerRatesUsdPerMTok, [
    'standardOp', 'deepOp', 'standardScript', 'scheduledScript', 'priorityScript',
  ], 'providerRatesUsdPerMTok');
  if (typeof rates.version !== 'string' || !RATE_VERSION.test(rates.version)) {
    throw new Error('version must be a bounded rate-card identifier');
  }
  assertCanonicalTimestamp(rates.capturedAt, 'capturedAt');

  for (const cls of ['standardOp', 'deepOp', ...Object.keys(SCRIPT_CLASSES)]) {
    assertExactKeys(rates.providerRatesUsdPerMTok[cls], ['input', 'output'], `providerRatesUsdPerMTok.${cls}`);
    for (const side of ['input', 'output']) {
      assertFiniteRange(
        rates.providerRatesUsdPerMTok[cls][side],
        `providerRatesUsdPerMTok.${cls}.${side}`,
        0,
        100_000,
      );
    }
  }
  assertFiniteRange(rates.stripeFeePct, 'stripeFeePct', 0, 1);
  assertFiniteRange(rates.stripeFeeFixedUsd, 'stripeFeeFixedUsd', 0, 1_000_000);
  assertFiniteRange(rates.appleProceedsPct, 'appleProceedsPct', Number.EPSILON, 1);
  assertFiniteRange(rates.vpsAllocationUsdPerPaidUser, 'vpsAllocationUsdPerPaidUser', 0, 1_000_000);
  assertFiniteRange(rates.refundsPct, 'refundsPct', 0, 1);
  assertFiniteRange(rates.taxesPct, 'taxesPct', 0, 1);
  assertExactKeys(rates.projectedCohortCounts, PROFILE_IDS, 'projectedCohortCounts');
  for (const profileId of PROFILE_IDS) {
    assertExactKeys(
      rates.projectedCohortCounts[profileId],
      CHANNELS,
      `projectedCohortCounts.${profileId}`,
    );
    for (const channel of CHANNELS) {
      assertFiniteRange(
        rates.projectedCohortCounts[profileId][channel],
        `projectedCohortCounts.${profileId}.${channel}`,
        0,
        1_000_000_000,
        { integer: true },
      );
    }
  }
  if (PROFILE_IDS.every((profileId) => (
    CHANNELS.every((channel) => rates.projectedCohortCounts[profileId][channel] === 0)
  ))) {
    throw new Error('projectedCohortCounts must include at least one paid cohort');
  }

  // Addendum C: scheduled scripts share the 10-credit price with standard
  // scripts and must not cost more to serve.
  const scheduled = rates.providerRatesUsdPerMTok.scheduledScript;
  const standard = rates.providerRatesUsdPerMTok.standardScript;
  if (scheduled.input > standard.input || scheduled.output > standard.output) {
    throw new Error('rate card invalid: scheduledScript rates exceed standardScript rates (Addendum C: scheduled <= standard)');
  }
  return rates;
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function assertMetricEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match the recomputed script evidence`);
}

function validateP95Row(row, label, expectedCount = null) {
  assertExactKeys(row, [
    'sampleCount', 'inputTokens', 'outputTokens', 'modelCostUsd', 'toolCostUsd',
  ], label);
  assertFiniteRange(row.sampleCount, `${label} sampleCount`, 1, 10_000_000, { integer: true });
  if (expectedCount !== null && row.sampleCount !== expectedCount) {
    throw new Error(`${label} sample count must equal ${expectedCount}`);
  }
  assertFiniteRange(row.inputTokens, `${label} inputTokens`, 1, 10_000_000, { integer: true });
  assertFiniteRange(row.outputTokens, `${label} outputTokens`, 1, 10_000_000, { integer: true });
  assertFiniteRange(row.modelCostUsd, `${label} modelCostUsd`, 0, 1_000_000);
  assertFiniteRange(row.toolCostUsd, `${label} toolCostUsd`, 0, 1_000_000);
  return row;
}

function validateOperationP95Row(row, label) {
  assertExactKeys(row, [
    'sampleCount', 'failedOnlyOperationCount',
    'failedOnlyInputTokensAllocated', 'failedOnlyOutputTokensAllocated',
    'failedOnlyModelCostUsdAllocated', 'failedOnlyToolCostUsdAllocated',
    'inputTokens', 'outputTokens', 'modelCostUsd', 'toolCostUsd',
  ], label);
  validateP95Row({
    sampleCount: row.sampleCount,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    modelCostUsd: row.modelCostUsd,
    toolCostUsd: row.toolCostUsd,
  }, label);
  assertFiniteRange(row.failedOnlyOperationCount, `${label} failedOnlyOperationCount`, 0, 10_000_000, {
    integer: true,
  });
  assertFiniteRange(row.failedOnlyInputTokensAllocated, `${label} failedOnlyInputTokensAllocated`, 0, 10_000_000, {
    integer: true,
  });
  assertFiniteRange(row.failedOnlyOutputTokensAllocated, `${label} failedOnlyOutputTokensAllocated`, 0, 10_000_000, {
    integer: true,
  });
  assertFiniteRange(row.failedOnlyModelCostUsdAllocated, `${label} failedOnlyModelCostUsdAllocated`, 0, 1_000_000);
  assertFiniteRange(row.failedOnlyToolCostUsdAllocated, `${label} failedOnlyToolCostUsdAllocated`, 0, 1_000_000);
  return row;
}

export function validateAcceptanceEvidence(
  evidence,
  { workloadSourceSha, producerSourceSha, producerToolSource },
) {
  if (workloadSourceSha === producerSourceSha) {
    throw new Error('acceptance evidence requires distinct workload and producer commits');
  }
  assertExactKeys(evidence, EVIDENCE_TOP_LEVEL_KEYS, 'acceptance evidence');
  if (evidence.schemaVersion !== CONTENT_TEN_SCRIPT_EVIDENCE_SCHEMA
      || evidence.acceptanceRevision !== TEN_SCRIPT_ACCEPTANCE_REVISION
      || evidence.workloadSourceSha !== workloadSourceSha
      || evidence.producerSourceSha !== producerSourceSha
      || evidence.acceptancePass !== true) {
    throw new Error('acceptance evidence does not match the governed workload/producer source pair');
  }
  const governedProducerToolSource = validateImmutableToolSourceBinding(
    producerToolSource,
    {
      producerSourceSha,
      entrypoint: ACCEPTANCE_EVIDENCE_ENTRYPOINT,
      modulePaths: CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES,
    },
  );
  const evidenceProducerToolSource = validateImmutableToolSourceBinding(
    evidence.producerToolSource,
    {
      producerSourceSha,
      entrypoint: ACCEPTANCE_EVIDENCE_ENTRYPOINT,
      modulePaths: CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES,
    },
  );
  if (canonicalJson(evidenceProducerToolSource) !== canonicalJson(governedProducerToolSource)) {
    throw new Error('acceptance evidence producer tool does not match the receipt-bound module closure');
  }
  assertDigest(evidence.sourceBindingSha256, 'acceptance evidence sourceBindingSha256');
  if (evidence.sourceBindingSha256
      !== acceptanceSourceBindingSha256(
        workloadSourceSha,
        producerSourceSha,
        evidenceProducerToolSource.bindingSha256,
      )) {
    throw new Error('acceptance evidence workload/producer source binding is invalid');
  }
  assertCanonicalTimestamp(evidence.generatedAt, 'acceptance evidence generatedAt');
  assertDigest(evidence.stateSha256, 'acceptance evidence stateSha256');
  assertDigest(evidence.scopeSha256, 'acceptance evidence scopeSha256');

  assertExactKeys(evidence.workloadRelease, [
    'viewSchema', 'capturedAt', 'releaseId', 'sourceSha', 'stateStatus',
    'receiptSchema', 'receiptOutcome', 'receiptCompletedAt', 'releasePayloadDigest',
    'backendImageDigest', 'boundAt', 'viewSha256',
  ], 'acceptance evidence workloadRelease');
  if (evidence.workloadRelease.viewSchema !== 'nexus.release-state-view.v2'
      || evidence.workloadRelease.sourceSha !== workloadSourceSha
      || evidence.workloadRelease.stateStatus !== 'completed'
      || evidence.workloadRelease.receiptSchema !== 'nexus.release-receipt.v3'
      || evidence.workloadRelease.receiptOutcome !== 'completed'
      || !RELEASE_ID.test(evidence.workloadRelease.releaseId ?? '')) {
    throw new Error('acceptance evidence workload release proof is invalid');
  }
  assertDigest(evidence.workloadRelease.releasePayloadDigest, 'acceptance workload release payload digest');
  assertDigest(evidence.workloadRelease.backendImageDigest, 'acceptance workload backend image digest');
  assertDigest(evidence.workloadRelease.viewSha256, 'acceptance workload release viewSha256');
  assertCanonicalTimestamp(evidence.workloadRelease.capturedAt, 'acceptance workload release capturedAt');
  assertCanonicalTimestamp(evidence.workloadRelease.receiptCompletedAt, 'acceptance workload receiptCompletedAt');
  assertCanonicalTimestamp(evidence.workloadRelease.boundAt, 'acceptance workload release boundAt');
  if (Date.parse(evidence.workloadRelease.receiptCompletedAt)
        > Date.parse(evidence.workloadRelease.capturedAt)
      || Date.parse(evidence.workloadRelease.capturedAt)
        > Date.parse(evidence.workloadRelease.boundAt)) {
    throw new Error('acceptance evidence workload release timestamps are not causal');
  }

  const runtimeRelease = evidence.productionSmokeRuntimeRelease;
  assertExactKeys(runtimeRelease, [
    'schemaVersion', 'jobId', 'creation', 'completion',
  ], 'acceptance evidence production smoke runtime release');
  const smoke = evidence.scripts?.find((row) => row?.phase === 'production-smoke');
  if (runtimeRelease.schemaVersion !== CONTENT_SCRIPT_RUNTIME_RELEASE_SCHEMA
      || runtimeRelease.jobId !== smoke?.jobId) {
    throw new Error('acceptance evidence production smoke runtime release identity is invalid');
  }
  for (const [label, identity] of Object.entries({
    creation: runtimeRelease.creation,
    completion: runtimeRelease.completion,
  })) {
    assertExactKeys(identity, [
      'releaseId', 'sourceSha', 'backendImageDigest',
    ], `acceptance evidence production smoke ${label} release`);
    if (identity.releaseId !== evidence.workloadRelease.releaseId
        || identity.sourceSha !== workloadSourceSha
        || identity.backendImageDigest !== evidence.workloadRelease.backendImageDigest) {
      throw new Error(`acceptance evidence production smoke ${label} release does not match workload evidence`);
    }
    assertDigest(identity.backendImageDigest, `acceptance evidence production smoke ${label} backend image digest`);
  }

  assertExactKeys(evidence.qualityReview, [
    'schemaVersion', 'sha256', 'reviewedAt', 'reviewType', 'attestation',
  ], 'acceptance evidence qualityReview');
  if (evidence.qualityReview.schemaVersion !== CONTENT_TEN_SCRIPT_QUALITY_REVIEW_SCHEMA
      || evidence.qualityReview.reviewType !== 'independent'
      || evidence.qualityReview.attestation !== 'no_critical_quality_regression') {
    throw new Error('acceptance evidence quality review contract is invalid');
  }
  assertCanonicalTimestamp(evidence.qualityReview.reviewedAt, 'acceptance evidence quality reviewedAt');
  assertDigest(evidence.qualityReview.sha256, 'acceptance evidence qualityReview sha256');

  assertExactKeys(evidence.release, [
    'viewSchema', 'capturedAt', 'releaseId', 'sourceSha', 'stateStatus',
    'receiptSchema', 'receiptOutcome', 'receiptCompletedAt', 'releasePayloadDigest',
    'viewSha256',
  ], 'acceptance evidence release');
  assertDigest(evidence.release.viewSha256, 'acceptance evidence release viewSha256');
  if (evidence.release.viewSchema !== 'nexus.release-state-view.v2'
      || evidence.release.sourceSha !== producerSourceSha
      || evidence.release.stateStatus !== 'completed'
      || evidence.release.receiptSchema !== 'nexus.release-receipt.v3'
      || evidence.release.receiptOutcome !== 'completed'
      || !RELEASE_ID.test(evidence.release.releaseId ?? '')) {
    throw new Error('acceptance evidence release binding is not a completed v3 receipt for --producer-source-sha');
  }
  assertDigest(evidence.release.releasePayloadDigest, 'acceptance evidence release payload digest');
  assertCanonicalTimestamp(evidence.release.capturedAt, 'acceptance evidence release capturedAt');
  assertCanonicalTimestamp(evidence.release.receiptCompletedAt, 'acceptance evidence receiptCompletedAt');

  assertExactKeys(evidence.inventory, [
    'count', 'delivery', 'languages', 'preRelease', 'productionSmoke',
  ], 'acceptance evidence inventory');
  assertExactKeys(evidence.inventory.delivery, ['standard', 'scheduled', 'priority'], 'acceptance evidence delivery inventory');
  assertExactKeys(evidence.inventory.languages, ['en', 'pt-BR'], 'acceptance evidence language inventory');
  if (evidence.inventory.count !== 10 || evidence.inventory.preRelease !== 9
      || evidence.inventory.productionSmoke !== 1
      || Object.entries(DELIVERY_SAMPLE_COUNTS).some(([mode, count]) => evidence.inventory.delivery[mode] !== count)
      || evidence.inventory.languages.en !== 5 || evidence.inventory.languages['pt-BR'] !== 5) {
    throw new Error('acceptance evidence inventory does not match the immutable ten-script contract');
  }

  if (!Array.isArray(evidence.scripts) || evidence.scripts.length !== 10) {
    throw new Error('acceptance evidence must contain exactly ten script rows');
  }
  const jobIds = new Set();
  evidence.scripts.forEach((row, index) => {
    const expected = TEN_SCRIPT_ACCEPTANCE_SCENARIOS[index];
    assertExactKeys(row, [
      'id', 'phase', 'deliveryMode', 'language', 'topicSha256', 'jobId',
      'scriptSha256', 'wordCount', 'sourceConsistent', 'route', 'modelDigest',
      'provider', 'model', 'createdAt', 'completedAt', 'inputTokens', 'outputTokens',
      'modelCostUsd', 'toolCostUsd',
    ], `acceptance evidence script ${index + 1}`);
    if (!expected || row.id !== expected.id || row.phase !== expected.phase
        || row.deliveryMode !== expected.deliveryMode || row.language !== expected.language
        || row.topicSha256 !== sha256(Buffer.from(expected.topic))
        || !JOB_ID.test(row.jobId ?? '')
        || row.sourceConsistent !== true || row.route !== 'cloud'
        || row.modelDigest !== null || row.provider !== EXPECTED_SCRIPT_PROVIDER
        || row.model !== EXPECTED_SCRIPT_MODEL) {
      throw new Error(`acceptance evidence script ${expected?.id ?? index + 1} identity/routing is invalid`);
    }
    assertDigest(row.scriptSha256, `${row.id} scriptSha256`);
    assertFiniteRange(row.wordCount, `${row.id} wordCount`, 1900, 2400, { integer: true });
    assertCanonicalTimestamp(row.createdAt, `${row.id} createdAt`);
    assertCanonicalTimestamp(row.completedAt, `${row.id} completedAt`);
    if (Date.parse(row.completedAt) < Date.parse(row.createdAt)) {
      throw new Error(`${row.id} completion precedes creation`);
    }
    assertFiniteRange(row.inputTokens, `${row.id} inputTokens`, 1, 10_000_000, { integer: true });
    assertFiniteRange(row.outputTokens, `${row.id} outputTokens`, 1, 10_000_000, { integer: true });
    assertFiniteRange(row.modelCostUsd, `${row.id} modelCostUsd`, 0, 1_000_000);
    assertFiniteRange(row.toolCostUsd, `${row.id} toolCostUsd`, 0, 1_000_000);
    jobIds.add(row.jobId);
  });
  if (jobIds.size !== 10) throw new Error('acceptance evidence job identities are not unique');

  assertExactKeys(evidence.p95Tokens, ['input', 'output'], 'acceptance evidence p95Tokens');
  assertMetricEqual(evidence.p95Tokens.input, percentile95(evidence.scripts.map((row) => row.inputTokens)), 'p95Tokens.input');
  assertMetricEqual(evidence.p95Tokens.output, percentile95(evidence.scripts.map((row) => row.outputTokens)), 'p95Tokens.output');
  assertExactKeys(evidence.p95ByDeliveryMode, ['standard', 'scheduled', 'priority'], 'acceptance evidence p95ByDeliveryMode');
  for (const [mode, count] of Object.entries(DELIVERY_SAMPLE_COUNTS)) {
    const row = validateP95Row(evidence.p95ByDeliveryMode[mode], `acceptance evidence ${mode} p95`, count);
    const scripts = evidence.scripts.filter((script) => script.deliveryMode === mode);
    assertMetricEqual(row.inputTokens, percentile95(scripts.map((script) => script.inputTokens)), `${mode} p95 inputTokens`);
    assertMetricEqual(row.outputTokens, percentile95(scripts.map((script) => script.outputTokens)), `${mode} p95 outputTokens`);
    assertMetricEqual(row.modelCostUsd, percentile95(scripts.map((script) => script.modelCostUsd)), `${mode} p95 modelCostUsd`);
    assertMetricEqual(row.toolCostUsd, percentile95(scripts.map((script) => script.toolCostUsd)), `${mode} p95 toolCostUsd`);
  }
  const totalModelCostUsd = Number(evidence.scripts.reduce((sum, row) => sum + row.modelCostUsd, 0).toFixed(6));
  const totalToolCostUsd = Number(evidence.scripts.reduce((sum, row) => sum + row.toolCostUsd, 0).toFixed(6));
  assertMetricEqual(evidence.totalModelCostUsd, totalModelCostUsd, 'totalModelCostUsd');
  assertMetricEqual(evidence.totalToolCostUsd, totalToolCostUsd, 'totalToolCostUsd');

  const operations = evidence.operationUsage;
  assertExactKeys(operations, [
    'schemaVersion', 'classificationVersion', 'capturedAt', 'windowStart',
    'windowEnd', 'scopeSha256', 'classes',
  ], 'operation usage evidence');
  assertExactKeys(operations.classes, ['standardOp', 'deepOp'], 'operation usage classes');
  if (operations.schemaVersion !== OPERATION_USAGE_EVIDENCE_SCHEMA
      || operations.classificationVersion !== OPERATION_USAGE_CLASSIFICATION_VERSION
      || operations.scopeSha256 !== evidence.scopeSha256) {
    throw new Error('operation usage evidence schema/classification/scope binding is invalid');
  }
  assertDigest(operations.scopeSha256, 'operation usage scopeSha256');
  assertCanonicalTimestamp(operations.capturedAt, 'operation usage capturedAt');
  assertCanonicalTimestamp(operations.windowStart, 'operation usage windowStart');
  assertCanonicalTimestamp(operations.windowEnd, 'operation usage windowEnd');
  if (operations.capturedAt !== operations.windowEnd
      || Date.parse(operations.windowEnd) - Date.parse(operations.windowStart) !== 90 * 24 * 60 * 60 * 1_000) {
    throw new Error('operation usage evidence must cover the exact retained 90-day snapshot window');
  }
  for (const operationClass of ['standardOp', 'deepOp']) {
    validateOperationP95Row(operations.classes[operationClass], `operation usage ${operationClass}`);
  }

  const latestCompletion = Math.max(...evidence.scripts.map((row) => Date.parse(row.completedAt)));
  const productionSmokeCompletion = Date.parse(
    evidence.scripts.find((row) => row.phase === 'production-smoke')?.completedAt ?? '',
  );
  const productionSmokeCreatedAt = Date.parse(
    evidence.scripts.find((row) => row.phase === 'production-smoke')?.createdAt ?? '',
  );
  if (!Number.isFinite(productionSmokeCreatedAt)
      || productionSmokeCreatedAt <= Date.parse(evidence.workloadRelease.boundAt)
      || productionSmokeCreatedAt <= Date.parse(evidence.workloadRelease.receiptCompletedAt)) {
    throw new Error('production smoke predates its authoritative workload release binding');
  }
  const workloadEvidenceTime = Math.max(
    productionSmokeCompletion,
    Date.parse(evidence.workloadRelease.boundAt),
    Date.parse(evidence.workloadRelease.capturedAt),
  );
  if (Date.parse(evidence.qualityReview.reviewedAt) < latestCompletion
      || Date.parse(evidence.qualityReview.reviewedAt) > Date.parse(evidence.generatedAt)
      || Date.parse(evidence.release.capturedAt) > Date.parse(evidence.generatedAt)
      || Date.parse(evidence.release.receiptCompletedAt) > Date.parse(evidence.release.capturedAt)
      || Date.parse(evidence.release.receiptCompletedAt) <= workloadEvidenceTime
      || Date.parse(operations.capturedAt) > Date.parse(evidence.generatedAt)) {
    throw new Error('acceptance evidence timestamps are not causally ordered');
  }
  return evidence;
}

function operationCost(rates, operationUsage, cls) {
  const rate = rates.providerRatesUsdPerMTok[cls];
  const tokens = operationUsage.classes[cls];
  const rateModelCostUsd = (tokens.inputTokens * rate.input
    + tokens.outputTokens * rate.output) / 1_000_000;
  const modelCostUsd = Math.max(rateModelCostUsd, tokens.modelCostUsd);
  return {
    modelCostUsd,
    toolCostUsd: tokens.toolCostUsd,
    totalCostUsd: modelCostUsd + tokens.toolCostUsd,
  };
}

function scriptCost(rates, p95ByDeliveryMode, cls) {
  const deliveryMode = SCRIPT_CLASSES[cls];
  const measured = p95ByDeliveryMode[deliveryMode];
  const rate = rates.providerRatesUsdPerMTok[cls];
  const rateModelCostUsd = (measured.inputTokens * rate.input
    + measured.outputTokens * rate.output) / 1_000_000;
  const modelCostUsd = Math.max(rateModelCostUsd, measured.modelCostUsd);
  return {
    modelCostUsd,
    // Search/tool cost is measured from the accepted production jobs and must
    // not disappear from script-heavy profiles.
    toolCostUsd: measured.toolCostUsd,
    totalCostUsd: modelCostUsd + measured.toolCostUsd,
  };
}

function multiplyCost(cost, count) {
  return {
    modelCostUsd: cost.modelCostUsd * count,
    toolCostUsd: cost.toolCostUsd * count,
    totalCostUsd: cost.totalCostUsd * count,
  };
}

function addCosts(...costs) {
  return costs.reduce((total, cost) => ({
    modelCostUsd: total.modelCostUsd + cost.modelCostUsd,
    toolCostUsd: total.toolCostUsd + cost.toolCostUsd,
    totalCostUsd: total.totalCostUsd + cost.totalCostUsd,
  }), { modelCostUsd: 0, toolCostUsd: 0, totalCostUsd: 0 });
}

/** The five required monthly usage profiles, projected on both channels. */
export function buildProfiles(rates, p95ByDeliveryMode, operationUsage) {
  validateRateCard(rates);
  for (const [mode, count] of Object.entries(DELIVERY_SAMPLE_COUNTS)) {
    const row = p95ByDeliveryMode?.[mode];
    if (!row) throw new Error(`missing measured ${mode} script p95 evidence`);
    validateP95Row(row, `${mode} script p95`, count);
  }
  if (!operationUsage || operationUsage.schemaVersion !== OPERATION_USAGE_EVIDENCE_SCHEMA) {
    throw new Error('measured production operation usage evidence is required');
  }
  if (operationUsage.classificationVersion !== OPERATION_USAGE_CLASSIFICATION_VERSION) {
    throw new Error('measured production operation usage classification is stale');
  }
  for (const operationClass of ['standardOp', 'deepOp']) {
    validateOperationP95Row(operationUsage.classes?.[operationClass], `operation usage ${operationClass}`);
  }
  const standardOp = operationCost(rates, operationUsage, 'standardOp');
  const deepOp = operationCost(rates, operationUsage, 'deepOp');
  const standardScript = scriptCost(rates, p95ByDeliveryMode, 'standardScript');
  const scheduledScript = scriptCost(rates, p95ByDeliveryMode, 'scheduledScript');
  const priorityScript = scriptCost(rates, p95ByDeliveryMode, 'priorityScript');
  // Standard and Scheduled both consume ten credits. Price script-heavy
  // profiles with the more expensive measured path so Batch token/tool cost
  // cannot disappear merely because the profile label says "standard".
  const tenCreditScript = scheduledScript.totalCostUsd > standardScript.totalCostUsd
    ? scheduledScript
    : standardScript;

  const profile = (id, revenueUsd, cost, transactionCount = 1) => ({
    id,
    revenueUsd,
    transactionCount,
    modelCostUsd: cost.modelCostUsd,
    toolCostUsd: cost.toolCostUsd,
    providerCostUsd: cost.totalCostUsd,
  });
  const usageProfiles = [
    profile('pro_script_heavy', PLAN_PRICES_USD.pro,
      addCosts(multiplyCost(tenCreditScript, 30), multiplyCost(standardOp, 200))),
    profile('max_script_heavy', PLAN_PRICES_USD.max,
      addCosts(multiplyCost(tenCreditScript, 60), multiplyCost(standardOp, 600))),
    profile('chat_heavy', PLAN_PRICES_USD.max, multiplyCost(standardOp, 1200)),
    profile('reasoning_heavy', PLAN_PRICES_USD.max, multiplyCost(deepOp, 400)),
    // Max plus the 600-credit pack, spending all 1,800 credits on 150
    // 12-credit Priority scripts. Subscription and pack are distinct charges.
    profile('priority_pack_buyer', PLAN_PRICES_USD.max + PACK_600_PRICE_USD,
      multiplyCost(priorityScript, 150), 2),
  ];
  return usageProfiles.flatMap((usageProfile) => CHANNELS.map((channel) => ({
    ...usageProfile,
    channel,
    projectedCount: rates.projectedCohortCounts[usageProfile.id][channel],
  })));
}

function channelFeeUsd(rates, profile) {
  if (profile.channel === 'apple') {
    return profile.revenueUsd * (1 - rates.appleProceedsPct);
  }
  return profile.revenueUsd * rates.stripeFeePct
    + rates.stripeFeeFixedUsd * profile.transactionCount;
}

export function computeEconomics(rates, p95ByDeliveryMode, operationUsage) {
  validateRateCard(rates);
  const profiles = buildProfiles(rates, p95ByDeliveryMode, operationUsage).map((profile) => {
    const channelFee = channelFeeUsd(rates, profile);
    const refunds = profile.revenueUsd * rates.refundsPct;
    const taxes = profile.revenueUsd * rates.taxesPct;
    const totalCostUsd = profile.providerCostUsd + channelFee + refunds + taxes
      + rates.vpsAllocationUsdPerPaidUser;
    const marginUsd = profile.revenueUsd - totalCostUsd;
    for (const [label, value] of Object.entries({ channelFee, refunds, taxes, totalCostUsd, marginUsd })) {
      if (!Number.isFinite(value)) throw new Error(`computed ${label} is not finite`);
    }
    return {
      ...profile,
      channelFeeUsd: channelFee,
      refundsUsd: refunds,
      taxesUsd: taxes,
      vpsAllocationUsd: rates.vpsAllocationUsdPerPaidUser,
      totalCostUsd,
      marginUsd,
      marginPct: profile.revenueUsd > 0 ? marginUsd / profile.revenueUsd : 0,
    };
  });

  const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);
  const projectedMargin = (items) => {
    const projectedRevenue = sum(items, (profile) => profile.revenueUsd * profile.projectedCount);
    if (projectedRevenue <= 0) return 0;
    return sum(items, (profile) => profile.marginUsd * profile.projectedCount) / projectedRevenue;
  };
  const blendedMarginPct = projectedMargin(profiles);
  const webProfiles = profiles.filter((p) => p.channel === 'web');
  const appleProfiles = profiles.filter((p) => p.channel === 'apple');
  const webProjectedCount = sum(webProfiles, (profile) => profile.projectedCount);
  const appleProjectedCount = sum(appleProfiles, (profile) => profile.projectedCount);
  const webMarginPct = projectedMargin(webProfiles);
  const appleMarginPct = projectedMargin(appleProfiles);
  const gates = {
    blendedAtLeast80: blendedMarginPct >= 0.80,
    webHasPaidCohort: webProjectedCount > 0,
    webAtLeast80: webProjectedCount > 0 && webMarginPct >= 0.80,
    appleHasPaidCohort: appleProjectedCount > 0,
    appleFloor: appleProjectedCount > 0 && appleMarginPct >= 0.70,
  };
  return {
    profiles,
    blendedMarginPct,
    webMarginPct,
    appleMarginPct,
    gates,
    launchEligible: Object.values(gates).every(Boolean),
  };
}

export function buildEconomicsArtifact({
  rates,
  rateCardBytes,
  acceptanceEvidence,
  acceptanceEvidenceBytes,
  workloadReleaseView,
  workloadReleaseViewBytes,
  releaseView,
  releaseViewBytes,
  workloadSourceSha,
  producerSourceSha,
  acceptanceProducerToolSource,
  economicsProducerToolSource,
  authenticationSecret,
  generatedAt = new Date().toISOString(),
}) {
  if (!FULL_SHA.test(workloadSourceSha)) {
    throw new Error('workloadSourceSha must be an exact 40-character commit');
  }
  if (!FULL_SHA.test(producerSourceSha)) {
    throw new Error('producerSourceSha must be an exact 40-character commit');
  }
  if (workloadSourceSha === producerSourceSha) {
    throw new Error('workloadSourceSha and producerSourceSha must be distinct commits');
  }
  for (const [label, bytes] of Object.entries({
    rateCardBytes,
    acceptanceEvidenceBytes,
    workloadReleaseViewBytes,
    releaseViewBytes,
  })) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1) throw new Error(`${label} must be nonempty bytes`);
  }
  assertJsonBytesMatch(rates, rateCardBytes, 'rate card');
  assertJsonBytesMatch(acceptanceEvidence, acceptanceEvidenceBytes, 'acceptance evidence');
  assertJsonBytesMatch(workloadReleaseView, workloadReleaseViewBytes, 'workload release view');
  assertJsonBytesMatch(releaseView, releaseViewBytes, 'release view');
  validateRateCard(rates);
  validateAcceptanceEvidence(acceptanceEvidence, {
    workloadSourceSha,
    producerSourceSha,
    producerToolSource: acceptanceProducerToolSource,
  });
  const governedEconomicsProducerToolSource = validateImmutableToolSourceBinding(
    economicsProducerToolSource,
    {
      producerSourceSha,
      entrypoint: ECONOMICS_ENTRYPOINT,
      modulePaths: ECONOMICS_PRODUCER_MODULES,
    },
  );
  const workloadRelease = validateCompletedReleaseView(workloadReleaseView, workloadSourceSha);
  const release = validateCompletedReleaseView(releaseView, producerSourceSha);
  assertCanonicalTimestamp(generatedAt, 'economics generatedAt');
  const generatedAtMs = Date.parse(generatedAt);
  const rateCapturedAtMs = Date.parse(rates.capturedAt);
  if (rateCapturedAtMs > generatedAtMs
      || Date.parse(acceptanceEvidence.generatedAt) > Date.parse(generatedAt)) {
    throw new Error('economics inputs cannot be captured after artifact generation');
  }
  if (rateCapturedAtMs < Date.parse(acceptanceEvidence.generatedAt)
      || generatedAtMs - rateCapturedAtMs > RATE_CARD_MAX_AGE_MS) {
    throw new Error('actual-account rate card is stale or predates completed acceptance evidence');
  }
  if (release.sourceSha !== producerSourceSha || release.stateStatus !== 'completed'
      || release.receiptSchema !== 'nexus.release-receipt.v3'
      || release.receiptOutcome !== 'completed'
      || acceptanceEvidence.release.viewSha256 !== sha256(releaseViewBytes)
      || acceptanceEvidence.release.releaseId !== release.releaseId
      || acceptanceEvidence.release.releasePayloadDigest !== release.releasePayloadDigest
      || acceptanceEvidence.release.receiptCompletedAt !== release.receiptCompletedAt) {
    throw new Error('release view no longer matches the view and receipt bound by acceptance evidence');
  }
  if (acceptanceEvidence.workloadRelease.viewSha256 !== sha256(workloadReleaseViewBytes)
      || acceptanceEvidence.workloadRelease.releaseId !== workloadRelease.releaseId
      || acceptanceEvidence.workloadRelease.releasePayloadDigest
        !== workloadRelease.releasePayloadDigest
      || acceptanceEvidence.workloadRelease.receiptCompletedAt
        !== workloadRelease.receiptCompletedAt
      || acceptanceEvidence.workloadRelease.capturedAt !== workloadRelease.capturedAt
      || acceptanceEvidence.workloadRelease.backendImageDigest
        !== workloadReleaseView?.active?.images?.backend?.digest) {
    throw new Error('workload release view no longer matches acceptance evidence');
  }
  const result = computeEconomics(
    rates,
    acceptanceEvidence.p95ByDeliveryMode,
    acceptanceEvidence.operationUsage,
  );
  const payload = {
    generatedAt,
    workloadSourceSha,
    producerSourceSha,
    producerToolSource: governedEconomicsProducerToolSource,
    sourceBindingSha256: economicsSourceBindingSha256({
      workloadSourceSha,
      producerSourceSha,
      acceptanceSourceBindingSha256: acceptanceEvidence.sourceBindingSha256,
      economicsToolBindingSha256: governedEconomicsProducerToolSource.bindingSha256,
    }),
    bindings: {
      rateCard: {
        version: rates.version,
        capturedAt: rates.capturedAt,
        sha256: sha256(rateCardBytes),
        projectedCohortCounts: rates.projectedCohortCounts,
        projectedCohortCountsSha256: sha256(Buffer.from(canonicalJson(rates.projectedCohortCounts))),
        data: rates,
      },
      acceptance: {
        schemaVersion: acceptanceEvidence.schemaVersion,
        acceptancePass: acceptanceEvidence.acceptancePass,
        workloadSourceSha,
        evidenceSha256: sha256(acceptanceEvidenceBytes),
        stateSha256: acceptanceEvidence.stateSha256,
        producerToolSource: acceptanceProducerToolSource,
        qualityReviewSha256: acceptanceEvidence.qualityReview.sha256,
        scopeSha256: acceptanceEvidence.scopeSha256,
        workloadReleaseViewSha256: acceptanceEvidence.workloadRelease.viewSha256,
        evidence: acceptanceEvidence,
      },
      operationUsage: {
        schemaVersion: acceptanceEvidence.operationUsage.schemaVersion,
        classificationVersion: acceptanceEvidence.operationUsage.classificationVersion,
        sha256: sha256(Buffer.from(canonicalJson(acceptanceEvidence.operationUsage))),
      },
      release: {
        ...release,
        producerSourceSha,
        viewSha256: sha256(releaseViewBytes),
      },
      workloadRelease: {
        ...workloadRelease,
        backendImageDigest: acceptanceEvidence.workloadRelease.backendImageDigest,
        boundAt: acceptanceEvidence.workloadRelease.boundAt,
        viewSha256: sha256(workloadReleaseViewBytes),
      },
    },
    measuredScriptP95: acceptanceEvidence.p95ByDeliveryMode,
    measuredOperationP95: acceptanceEvidence.operationUsage,
    result,
  };
  const payloadSha256 = sha256(Buffer.from(canonicalJson(payload)));
  return {
    schemaVersion: ECONOMICS_ARTIFACT_SCHEMA,
    digestAlgorithm: 'sha256-canonical-json-payload-v1',
    payloadSha256,
    authentication: buildEconomicsActivationAuthentication(
      payloadSha256,
      authenticationSecret,
    ),
    payload,
  };
}

function requiredOption(args, flag) {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) refuse(`${flag} requires a value`, 64);
  return value;
}

function optionalOption(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) refuse(`${flag} requires a value`, 64);
  return value;
}

export async function main() {
  const args = process.argv.slice(2);
  const ratesPath = path.resolve(requiredOption(args, '--rates'));
  const acceptancePath = path.resolve(requiredOption(args, '--acceptance-evidence'));
  const workloadReleaseViewPath = path.resolve(requiredOption(args, '--workload-release-view'));
  const releaseViewPath = path.resolve(requiredOption(args, '--release-view'));
  const outputPath = path.resolve(requiredOption(args, '--output'));
  const workloadSourceSha = requiredOption(args, '--workload-source-sha');
  const producerSourceSha = requiredOption(args, '--producer-source-sha');
  const producerSourceRepository = optionalOption(args, '--producer-source-repository');
  if (!FULL_SHA.test(workloadSourceSha)) {
    refuse('--workload-source-sha must be an exact 40-character commit', 64);
  }
  if (!FULL_SHA.test(producerSourceSha)) {
    refuse('--producer-source-sha must be an exact 40-character commit', 64);
  }
  if (workloadSourceSha === producerSourceSha) {
    refuse('--workload-source-sha and --producer-source-sha must be distinct commits', 64);
  }

  const ratesInput = parsePrivateJson(ratesPath, 'rate card');
  const acceptanceInput = parsePrivateJson(acceptancePath, 'acceptance evidence');
  const workloadReleaseViewInput = parsePrivateJson(
    workloadReleaseViewPath,
    'workload release state view',
  );
  const releaseViewInput = parsePrivateJson(releaseViewPath, 'release state view');
  const sourceRoot = realpathSync.native(
    path.resolve(fileURLToPath(new URL('..', import.meta.url))),
  );
  let invokedEntrypoint;
  try {
    invokedEntrypoint = realpathSync.native(path.resolve(process.argv[1] ?? ''));
  } catch {
    refuse('economics producer entrypoint identity cannot be resolved', 78);
  }
  if (invokedEntrypoint !== path.join(sourceRoot, ECONOMICS_ENTRYPOINT)) {
    refuse('economics producer must execute its receipt-bound entrypoint directly', 78);
  }
  const immutableToolSourceInput = {
    producerSourceSha,
    sourceRoot,
    ...(producerSourceRepository ? { repositoryPath: producerSourceRepository } : {}),
  };
  const acceptanceProducerToolSource = resolveImmutableToolSourceBinding({
    ...immutableToolSourceInput,
    entrypoint: ACCEPTANCE_EVIDENCE_ENTRYPOINT,
    modulePaths: CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES,
  });
  const economicsProducerToolSource = resolveImmutableToolSourceBinding({
    ...immutableToolSourceInput,
    entrypoint: ECONOMICS_ENTRYPOINT,
    modulePaths: ECONOMICS_PRODUCER_MODULES,
  });
  const artifact = buildEconomicsArtifact({
    rates: ratesInput.value,
    rateCardBytes: ratesInput.bytes,
    acceptanceEvidence: acceptanceInput.value,
    acceptanceEvidenceBytes: acceptanceInput.bytes,
    workloadReleaseView: workloadReleaseViewInput.value,
    workloadReleaseViewBytes: workloadReleaseViewInput.bytes,
    releaseView: releaseViewInput.value,
    releaseViewBytes: releaseViewInput.bytes,
    workloadSourceSha,
    producerSourceSha,
    acceptanceProducerToolSource,
    economicsProducerToolSource,
    authenticationSecret: process.env.LOCAL_PRIMARY_ACTIVATION_EVIDENCE_HMAC_SECRET,
  });
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  atomicPrivateWrite(outputPath, bytes);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: artifact.schemaVersion,
    workloadSourceSha,
    producerSourceSha,
    producerToolBindingSha256: artifact.payload.producerToolSource.bindingSha256,
    sourceBindingSha256: artifact.payload.sourceBindingSha256,
    launchEligible: artifact.payload.result.launchEligible,
    gates: artifact.payload.result.gates,
    payloadSha256: artifact.payloadSha256,
    artifactSha256: sha256(bytes),
  }, null, 2)}\n`);
  process.exitCode = artifact.payload.result.launchEligible ? 0 : 2;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(
      `economics simulation refused: ${safeEconomicsCliFailureMessage(error)}\n`,
    );
    process.exitCode = error.exitCode || 1;
  });
}
