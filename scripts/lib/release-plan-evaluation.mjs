import { validateAuthoritativeReleaseEvidence } from './release-plan-authoritative-evidence.mjs';

export const RELEASE_OBSERVATION_WINDOW_SCHEMA = 'nexus.release-plan-observation-window.v1';
export const RELEASE_PLAN_EVALUATION_SCHEMA = 'nexus.release-plan-evaluation.v1';
export const RELEASE_SHADOW_LEDGER_SCHEMA = 'nexus.release-shadow-ledger.v1';
export const RELEASE_SHADOW_READINESS_SCHEMA = 'nexus.release-shadow-readiness.v1';

export const RELEASE_SHADOW_COMPARISON_SCHEMA = 'nexus.release-evidence-shadow-comparison.v1';
export const PROTECTED_MAIN_REUSE_SCOPE = 'vitest-and-exact-runtime-bundle-shadow';
export const RELEASE_SHADOW_CHECKS = Object.freeze([
  'exactRuntimeSha',
  'testPolicyMatch',
  'packageLockMatch',
  'pythonRequirementsMatch',
  'nodeToolchainMatch',
  'pythonToolchainMatch',
  'mainSelectionCoversRelease',
  'protectedJobsPassed',
  'runtimeArtifactMatch',
]);

export const RELEASE_PLAN_THRESHOLDS = Object.freeze({
  automatedReadinessP50Ms: 9 * 60_000,
  unattendedHandoffP50Ms: 60_000,
  rollbackRecoveryMaxMs: 120_000,
  minimumSuccessfulSoakMs: 60_000,
});

export const RELEASE_AUTOMATED_STAGES = Object.freeze([
  'protected_main_ci',
  'release_candidate',
  'protected_signing',
  'staging_validation',
  'promotion',
]);

const OBSERVATION_COUNT = 10;
const SHADOW_COUNT = 5;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const APPROVAL_KINDS = new Set([
  null,
  'release_signing',
  'production_owner',
  'migration_owner',
]);
const PROMOTION_OUTCOMES = new Set([
  'passed',
  'recovered',
  'failed_before_stop',
  'recovery_failed',
]);

export class ReleasePlanEvaluationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleasePlanEvaluationError';
  }
}

function fail(message) {
  throw new ReleasePlanEvaluationError(message);
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

function requireSafeInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requireSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function requireSha(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) fail(`${label} is invalid`);
  return value;
}

function requireDigest(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) fail(`${label} is invalid`);
  return value;
}

function timestampMs(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') fail(`${label} must be a canonical UTC timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function requireChronology(earlier, later, label, { allowEqual = true } = {}) {
  if ((allowEqual && earlier > later) || (!allowEqual && earlier >= later)) {
    fail(`${label} chronology is invalid`);
  }
}

function roundMetric(value) {
  return Math.round((value + Number.EPSILON) * 1_000) / 1_000;
}

export function percentile(values, probability) {
  if (!Array.isArray(values) || values.length === 0) fail('percentile requires at least one sample');
  if (typeof probability !== 'number' || probability < 0 || probability > 1) {
    fail('percentile probability must be between zero and one');
  }
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    fail('percentile samples must be finite non-negative numbers');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return roundMetric(sorted[lower]);
  const interpolated = sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  return roundMetric(interpolated);
}

function durationSummary(values) {
  if (values.length === 0) {
    return {
      sampleCount: 0,
      medianMs: null,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    };
  }
  const p50Ms = percentile(values, 0.5);
  return {
    sampleCount: values.length,
    medianMs: p50Ms,
    p50Ms,
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  };
}

function validateIdentity(identity, label) {
  exactKeys(identity, [
    'evidenceRuntimeSha',
    'manifestRuntimeSha',
    'stagingRuntimeSha',
    'productionRuntimeSha',
    'evidenceArtifactDigest',
    'manifestArtifactDigest',
    'stagingArtifactDigest',
    'productionArtifactDigest',
    'stagingInstalledRuntimeDigest',
    'productionInstalledRuntimeDigest',
  ], label);
  for (const name of ['evidenceRuntimeSha', 'manifestRuntimeSha', 'stagingRuntimeSha']) {
    requireSha(identity[name], `${label}.${name}`);
  }
  requireSha(identity.productionRuntimeSha, `${label}.productionRuntimeSha`, { nullable: true });
  for (const name of [
    'evidenceArtifactDigest',
    'manifestArtifactDigest',
    'stagingArtifactDigest',
    'stagingInstalledRuntimeDigest',
  ]) {
    requireDigest(identity[name], `${label}.${name}`);
  }
  requireDigest(identity.productionArtifactDigest, `${label}.productionArtifactDigest`, { nullable: true });
  requireDigest(identity.productionInstalledRuntimeDigest, `${label}.productionInstalledRuntimeDigest`, { nullable: true });
}

function validateHandoff(handoff, label, bounds) {
  exactKeys(handoff, ['phase', 'readyAt', 'startedAt', 'approvalKind'], label);
  requireSafeId(handoff.phase, `${label}.phase`);
  if (!APPROVAL_KINDS.has(handoff.approvalKind)) fail(`${label}.approvalKind is invalid`);
  const readyAt = timestampMs(handoff.readyAt, `${label}.readyAt`);
  const startedAt = timestampMs(handoff.startedAt, `${label}.startedAt`);
  requireChronology(readyAt, startedAt, label);
  if (readyAt < bounds.startedAt || startedAt > bounds.completedAt) {
    fail(`${label} is outside the release observation interval`);
  }
  return {
    phase: handoff.phase,
    approvalKind: handoff.approvalKind,
    readyAt,
    startedAt,
    durationMs: startedAt - readyAt,
  };
}

function validateAutomatedStages(stages, label, bounds) {
  if (!Array.isArray(stages) || stages.length !== RELEASE_AUTOMATED_STAGES.length) {
    fail(`${label} must contain the exact canonical release stages`);
  }
  const validated = stages.map((stage, index) => {
    const stageLabel = `${label}[${index}]`;
    exactKeys(stage, ['phase', 'startedAt', 'completedAt'], stageLabel);
    if (stage.phase !== RELEASE_AUTOMATED_STAGES[index]) {
      fail(`${label} must follow the canonical stage order`);
    }
    const startedAt = timestampMs(stage.startedAt, `${stageLabel}.startedAt`);
    const completedAt = timestampMs(stage.completedAt, `${stageLabel}.completedAt`);
    requireChronology(startedAt, completedAt, stageLabel, { allowEqual: false });
    if (startedAt < bounds.startedAt || completedAt > bounds.completedAt) {
      fail(`${stageLabel} is outside the release observation interval`);
    }
    return {
      phase: stage.phase,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
    };
  });
  for (let index = 1; index < validated.length; index += 1) {
    if (validated[index].startedAt < validated[index - 1].completedAt) {
      fail(`${label} cannot overlap or run concurrently`);
    }
  }
  return validated;
}

function validateCutover(cutover, label, recordCompletedAt, outcome) {
  if (cutover === null) {
    if (outcome !== 'failed_before_stop') fail(`${label} is required for outcome ${outcome}`);
    return null;
  }
  exactKeys(cutover, [
    'startedAt',
    'serviceUnavailableAt',
    'serviceAvailableAt',
    'soakStartedAt',
    'soakCompletedAt',
    'completedAt',
  ], label);
  if (outcome === 'failed_before_stop') fail(`${label} must be null before service mutation`);

  const startedAt = timestampMs(cutover.startedAt, `${label}.startedAt`);
  const unavailableAt = timestampMs(cutover.serviceUnavailableAt, `${label}.serviceUnavailableAt`);
  const availableAt = timestampMs(cutover.serviceAvailableAt, `${label}.serviceAvailableAt`, { nullable: true });
  const soakStartedAt = timestampMs(cutover.soakStartedAt, `${label}.soakStartedAt`, { nullable: true });
  const soakCompletedAt = timestampMs(cutover.soakCompletedAt, `${label}.soakCompletedAt`, { nullable: true });
  const completedAt = timestampMs(cutover.completedAt, `${label}.completedAt`, { nullable: true });

  requireChronology(startedAt, unavailableAt, label);
  if (availableAt !== null) requireChronology(unavailableAt, availableAt, label);
  if ((soakStartedAt === null) !== (soakCompletedAt === null)) {
    fail(`${label} soak timestamps must both be present or both be null`);
  }
  if (soakStartedAt !== null) {
    requireChronology(startedAt, soakStartedAt, label);
    requireChronology(soakStartedAt, soakCompletedAt, label, { allowEqual: false });
  }
  if (outcome !== 'passed' && soakStartedAt !== null) {
    fail(`${label} cannot claim a successful soak when promotion did not pass`);
  }
  if (completedAt !== null) {
    requireChronology(startedAt, completedAt, label);
    for (const point of [availableAt, soakCompletedAt]) {
      if (point !== null) requireChronology(point, completedAt, label);
    }
  }
  if (outcome === 'passed') {
    if (availableAt === null || soakStartedAt === null || soakCompletedAt === null || completedAt === null) {
      fail(`${label} must contain availability, soak, and completion timestamps for a passed promotion`);
    }
    requireChronology(availableAt, soakStartedAt, label);
  }
  if (outcome === 'recovered' && (availableAt === null || completedAt === null)) {
    fail(`${label} must contain restored availability and completion timestamps for a recovered promotion`);
  }
  for (const point of [startedAt, unavailableAt, availableAt, soakStartedAt, soakCompletedAt, completedAt]) {
    if (point !== null && point > recordCompletedAt) fail(`${label} extends beyond the record completion timestamp`);
  }

  return {
    startedAt,
    unavailableAt,
    availableAt,
    completedAt,
    actualUnavailabilityMs: availableAt === null ? null : availableAt - unavailableAt,
    totalCutoverMs: completedAt === null ? null : completedAt - startedAt,
    soakDurationMs: soakStartedAt === null ? null : soakCompletedAt - soakStartedAt,
  };
}

function validateRollback(rollback, label, outcome, recordCompletedAt) {
  if (rollback === null) {
    if (outcome === 'recovered' || outcome === 'recovery_failed') {
      fail(`${label} is required for outcome ${outcome}`);
    }
    return null;
  }
  exactKeys(rollback, ['triggeredAt', 'healthyAt', 'status'], label);
  if (outcome !== 'recovered' && outcome !== 'recovery_failed') {
    fail(`${label} is not allowed for outcome ${outcome}`);
  }
  if (!['passed', 'failed'].includes(rollback.status)) fail(`${label}.status is invalid`);
  if ((outcome === 'recovered') !== (rollback.status === 'passed')) {
    fail(`${label}.status contradicts the promotion outcome`);
  }
  const triggeredAt = timestampMs(rollback.triggeredAt, `${label}.triggeredAt`);
  const healthyAt = timestampMs(rollback.healthyAt, `${label}.healthyAt`, { nullable: true });
  if (rollback.status === 'passed' && healthyAt === null) fail(`${label}.healthyAt is required after recovery`);
  if (rollback.status === 'failed' && healthyAt !== null) fail(`${label}.healthyAt must be null after failed recovery`);
  if (healthyAt !== null) requireChronology(triggeredAt, healthyAt, label);
  if (triggeredAt > recordCompletedAt || (healthyAt !== null && healthyAt > recordCompletedAt)) {
    fail(`${label} extends beyond the record completion timestamp`);
  }
  return healthyAt === null ? null : healthyAt - triggeredAt;
}

function validateReleaseRecord(record, index) {
  const label = `releases[${index}]`;
  exactKeys(record, [
    'releaseId',
    'completedAt',
    'identity',
    'timing',
    'promotion',
    'escapedReleaseDefects',
    'authoritativeEvidence',
  ], label);
  requireSafeId(record.releaseId, `${label}.releaseId`);
  const completedAt = timestampMs(record.completedAt, `${label}.completedAt`);
  requireSafeInteger(record.escapedReleaseDefects, `${label}.escapedReleaseDefects`);
  validateIdentity(record.identity, `${label}.identity`);

  exactKeys(record.timing, [
    'automatedReadinessStartedAt',
    'automatedReadinessCompletedAt',
    'automatedStages',
    'handoffs',
    'cutover',
  ], `${label}.timing`);
  const readinessStartedAt = timestampMs(
    record.timing.automatedReadinessStartedAt,
    `${label}.timing.automatedReadinessStartedAt`,
  );
  const readinessCompletedAt = timestampMs(
    record.timing.automatedReadinessCompletedAt,
    `${label}.timing.automatedReadinessCompletedAt`,
  );
  requireChronology(readinessStartedAt, readinessCompletedAt, `${label}.timing.automatedReadiness`, {
    allowEqual: false,
  });
  requireChronology(readinessCompletedAt, completedAt, label);
  const automatedStages = validateAutomatedStages(
    record.timing.automatedStages,
    `${label}.timing.automatedStages`,
    { startedAt: readinessStartedAt, completedAt },
  );
  if (automatedStages[0].startedAt !== readinessStartedAt) {
    fail(`${label}.timing automated readiness must start with protected-main CI`);
  }
  if (automatedStages[3].completedAt !== readinessCompletedAt) {
    fail(`${label}.timing automated readiness must complete with staging validation`);
  }
  if (automatedStages[4].startedAt < readinessCompletedAt) {
    fail(`${label}.timing promotion cannot start before staging validation completes`);
  }
  if (!Array.isArray(record.timing.handoffs) || record.timing.handoffs.length === 0) {
    fail(`${label}.timing.handoffs must contain observed phase transitions`);
  }
  const handoffs = record.timing.handoffs.map((handoff, handoffIndex) => validateHandoff(
    handoff,
    `${label}.timing.handoffs[${handoffIndex}]`,
    { startedAt: readinessStartedAt, completedAt },
  ));
  if (new Set(handoffs.map((handoff) => handoff.phase)).size !== handoffs.length) {
    fail(`${label}.timing.handoffs contains duplicate phases`);
  }
  for (let handoffIndex = 1; handoffIndex < handoffs.length; handoffIndex += 1) {
    if (handoffs[handoffIndex].readyAt < handoffs[handoffIndex - 1].startedAt) {
      fail(`${label}.timing.handoffs must be sequential`);
    }
  }
  if (!handoffs.some((handoff) => handoff.approvalKind === null)) {
    fail(`${label}.timing.handoffs must contain an unattended transition sample`);
  }
  for (const handoff of handoffs) {
    for (const stage of automatedStages) {
      if (handoff.readyAt < stage.completedAt && handoff.startedAt > stage.startedAt) {
        fail(`${label}.timing handoffs cannot overlap automated stage execution`);
      }
    }
  }
  if (automatedStages[4].startedAt !== handoffs.at(-1).startedAt) {
    fail(`${label}.timing promotion must start at the final handoff transition`);
  }

  exactKeys(record.promotion, ['outcome', 'rollback'], `${label}.promotion`);
  if (!PROMOTION_OUTCOMES.has(record.promotion.outcome)) {
    fail(`${label}.promotion.outcome is invalid`);
  }
  const outcome = record.promotion.outcome;
  const productionIdentity = [
    record.identity.productionRuntimeSha,
    record.identity.productionArtifactDigest,
    record.identity.productionInstalledRuntimeDigest,
  ];
  if (outcome === 'passed' && productionIdentity.some((value) => value === null)) {
    fail(`${label}.identity production fields are required for a passed promotion`);
  }
  if (outcome !== 'passed' && productionIdentity.some((value) => value !== null)) {
    fail(`${label}.identity production candidate fields must be null when promotion did not pass`);
  }
  if (outcome !== 'passed' && record.escapedReleaseDefects !== 0) {
    fail(`${label}.escapedReleaseDefects must be zero when the candidate did not reach production`);
  }
  const cutover = validateCutover(record.timing.cutover, `${label}.timing.cutover`, completedAt, outcome);
  if (cutover !== null && cutover.startedAt < handoffs.at(-1).startedAt) {
    fail(`${label}.timing.cutover cannot start before the final handoff begins`);
  }
  const promotionStage = automatedStages[4];
  if (cutover !== null && cutover.startedAt < promotionStage.startedAt) {
    fail(`${label}.timing.cutover cannot precede the promotion stage`);
  }
  if (outcome === 'passed' || outcome === 'recovered') {
    if (promotionStage.completedAt !== cutover.completedAt) {
      fail(`${label}.timing promotion must complete with cutover recovery or soak`);
    }
  } else if (promotionStage.completedAt !== completedAt) {
    fail(`${label}.timing failed promotion stage must complete with its journal record`);
  }
  const rollbackTriggerToHealthyMs = validateRollback(
    record.promotion.rollback,
    `${label}.promotion.rollback`,
    outcome,
    completedAt,
  );
  if (record.promotion.rollback !== null && cutover !== null) {
    const rollbackTriggeredAt = timestampMs(
      record.promotion.rollback.triggeredAt,
      `${label}.promotion.rollback.triggeredAt`,
    );
    if (rollbackTriggeredAt < cutover.unavailableAt) {
      fail(`${label}.promotion.rollback cannot precede observed service unavailability`);
    }
    if (outcome === 'recovered') {
      const rollbackHealthyAt = timestampMs(
        record.promotion.rollback.healthyAt,
        `${label}.promotion.rollback.healthyAt`,
      );
      if (rollbackHealthyAt !== cutover.availableAt) {
        fail(`${label} restored availability must match rollback recovery evidence`);
      }
    }
  }

  const candidateShaParity = new Set([
    record.identity.evidenceRuntimeSha,
    record.identity.manifestRuntimeSha,
    record.identity.stagingRuntimeSha,
  ]).size === 1;
  const candidateArtifactParity = new Set([
    record.identity.evidenceArtifactDigest,
    record.identity.manifestArtifactDigest,
    record.identity.stagingArtifactDigest,
  ]).size === 1;
  const productionArtifactAndShaParity = outcome !== 'passed' || (
    record.identity.productionRuntimeSha === record.identity.evidenceRuntimeSha
    && record.identity.productionArtifactDigest === record.identity.evidenceArtifactDigest
  );
  const installedRuntimeTreeParity = outcome !== 'passed'
    || record.identity.productionInstalledRuntimeDigest === record.identity.stagingInstalledRuntimeDigest;

  return {
    releaseId: record.releaseId,
    readinessStartedAt,
    completedAt,
    outcome,
    automatedReadinessMs: readinessCompletedAt - readinessStartedAt,
    automatedStageDurations: Object.fromEntries(
      automatedStages.map((stage) => [stage.phase, stage.durationMs]),
    ),
    unattendedHandoffMs: handoffs
      .filter((handoff) => handoff.approvalKind === null)
      .map((handoff) => handoff.durationMs),
    approvalHandoffMs: handoffs
      .filter((handoff) => handoff.approvalKind !== null)
      .map((handoff) => handoff.durationMs),
    cutover,
    rollbackRecoveryMs: outcome === 'recovered' ? cutover.actualUnavailabilityMs : null,
    rollbackTriggerToHealthyMs,
    parity: candidateShaParity
      && candidateArtifactParity
      && productionArtifactAndShaParity
      && installedRuntimeTreeParity,
    parityDetails: {
      candidateSha: candidateShaParity,
      candidateArtifact: candidateArtifactParity,
      productionArtifactAndSha: productionArtifactAndShaParity,
      installedRuntimeTree: installedRuntimeTreeParity,
    },
    escapedReleaseDefects: record.escapedReleaseDefects,
  };
}

export function validateReleaseObservationWindow(window, evidenceOptions = {}) {
  exactKeys(window, ['schema', 'generatedAt', 'baseline', 'releases'], 'release observation window');
  if (window.schema !== RELEASE_OBSERVATION_WINDOW_SCHEMA) {
    fail('release observation window schema is unsupported');
  }
  const generatedAt = timestampMs(window.generatedAt, 'release observation window.generatedAt');
  exactKeys(window.baseline, [
    'releaseCount',
    'failedPromotions',
    'escapedReleaseDefects',
  ], 'release observation window.baseline');
  requireSafeInteger(window.baseline.releaseCount, 'release observation window.baseline.releaseCount', {
    minimum: OBSERVATION_COUNT,
    maximum: OBSERVATION_COUNT,
  });
  requireSafeInteger(window.baseline.failedPromotions, 'release observation window.baseline.failedPromotions', {
    maximum: OBSERVATION_COUNT,
  });
  requireSafeInteger(
    window.baseline.escapedReleaseDefects,
    'release observation window.baseline.escapedReleaseDefects',
  );
  if (!Array.isArray(window.releases) || window.releases.length !== OBSERVATION_COUNT) {
    fail(`release observation window must contain exactly ${OBSERVATION_COUNT} production records`);
  }
  const releases = window.releases.map(validateReleaseRecord);
  if (new Set(releases.map((release) => release.releaseId)).size !== releases.length) {
    fail('release observation window contains duplicate release IDs');
  }
  for (let index = 1; index < releases.length; index += 1) {
    if (releases[index - 1].completedAt >= releases[index].completedAt) {
      fail('release observation window must be strictly chronological');
    }
    if (releases[index].readinessStartedAt < releases[index - 1].completedAt) {
      fail('release observation window cannot contain overlapping release lanes');
    }
  }
  if (generatedAt < releases.at(-1).completedAt) {
    fail('release observation window was generated before its final production record completed');
  }
  const authorities = window.releases.map((record, index) => (
    validateAuthoritativeReleaseEvidence(record, index, evidenceOptions)
  ));
  return {
    generatedAt: window.generatedAt,
    baseline: { ...window.baseline },
    releases: releases.map((release, index) => {
      const authority = authorities[index];
      return {
        ...release,
        cutover: release.cutover === null ? null : {
          ...release.cutover,
          actualUnavailabilityMs: authority.actualUnavailabilityMs
            ?? release.cutover.actualUnavailabilityMs,
        },
        rollbackRecoveryMs: release.outcome === 'recovered'
          ? authority.rollbackRecoveryMs
          : release.rollbackRecoveryMs,
        authority,
      };
    }),
  };
}

function metricStatus(passed) {
  return passed ? 'pass' : 'fail';
}

export function evaluateReleaseObservationWindow(window, evidenceOptions = {}) {
  const validated = validateReleaseObservationWindow(window, evidenceOptions);
  const readinessValues = validated.releases
    .filter((release) => release.authority.automatedReadinessStartExplicit)
    .map((release) => release.automatedReadinessMs);
  const unattendedValues = validated.releases
    .filter((release) => release.authority.handoffsExplicit)
    .flatMap((release) => release.unattendedHandoffMs);
  const approvalValues = validated.releases
    .filter((release) => release.authority.handoffsExplicit)
    .flatMap((release) => release.approvalHandoffMs);
  const actualUnavailabilityValues = validated.releases
    .map((release) => release.authority.actualUnavailabilityExplicit
      ? release.authority.actualUnavailabilityMs
      : null)
    .filter((value) => value !== null);
  const totalCutoverValues = validated.releases
    .map((release) => release.authority.totalCutoverExplicit
      ? release.cutover?.totalCutoverMs ?? null
      : null)
    .filter((value) => value !== null);
  const soakValues = validated.releases
    .filter((release) => release.outcome === 'passed' && release.authority.soakExplicit)
    .map((release) => release.authority.soakObservedMs);
  const rollbackValues = validated.releases
    .map((release) => release.authority.rollbackRecoveryMs)
    .filter((value) => value !== null);
  // Recovery authority records outage-to-healthy monotonic time, not the
  // operator-authored rollback trigger timestamp from the observation JSON.
  const rollbackTriggerValues = [];
  const automatedStageValues = Object.fromEntries(RELEASE_AUTOMATED_STAGES.map((stage) => [
    stage,
    validated.releases
      .filter((release) => release.authority.stageDurationsExplicit[stage])
      .map((release) => release.automatedStageDurations[stage]),
  ]));

  const readiness = durationSummary(readinessValues);
  const unattended = durationSummary(unattendedValues);
  const actualUnavailability = durationSummary(actualUnavailabilityValues);
  const totalCutover = durationSummary(totalCutoverValues);
  const soak = durationSummary(soakValues);
  const rollback = durationSummary(rollbackValues);
  const parityFailures = validated.releases
    .filter((release) => !release.parity)
    .map((release) => ({ releaseId: release.releaseId, checks: release.parityDetails }));
  const failedPromotions = validated.releases.filter((release) => release.outcome !== 'passed').length;
  const escapedReleaseDefects = validated.releases.reduce(
    (sum, release) => sum + release.escapedReleaseDefects,
    0,
  );
  const recoveryFailures = validated.releases
    .filter((release) => release.outcome === 'recovery_failed')
    .map((release) => release.releaseId);
  const passedPromotionCount = validated.releases.filter((release) => release.outcome === 'passed').length;
  const cutoverRecordCount = validated.releases.filter((release) => release.cutover !== null).length;

  const metrics = {
    automatedReadiness: {
      ...readiness,
      targetP50Ms: RELEASE_PLAN_THRESHOLDS.automatedReadinessP50Ms,
      status: readiness.sampleCount === validated.releases.length
        ? metricStatus(readiness.p50Ms <= RELEASE_PLAN_THRESHOLDS.automatedReadinessP50Ms)
        : 'manual_required',
    },
    automatedStageTimings: Object.fromEntries(RELEASE_AUTOMATED_STAGES.map((stage) => [
      stage,
      {
        ...durationSummary(automatedStageValues[stage]),
        status: automatedStageValues[stage].length === validated.releases.length
          ? 'observed'
          : 'manual_required',
      },
    ])),
    unattendedHandoffDelay: {
      ...unattended,
      excludedExplicitApprovalSampleCount: approvalValues.length,
      excludedExplicitApprovalTotalMs: approvalValues.reduce((sum, value) => sum + value, 0),
      targetP50Ms: RELEASE_PLAN_THRESHOLDS.unattendedHandoffP50Ms,
      status: validated.releases.every((release) => release.authority.handoffsExplicit)
        ? metricStatus(unattended.p50Ms <= RELEASE_PLAN_THRESHOLDS.unattendedHandoffP50Ms)
        : 'manual_required',
    },
    actualUnavailability: {
      ...actualUnavailability,
      status: actualUnavailability.sampleCount === cutoverRecordCount && cutoverRecordCount > 0
        ? 'observed'
        : 'manual_required',
    },
    totalCutoverIncludingSoak: {
      ...totalCutover,
      status: totalCutover.sampleCount === cutoverRecordCount && cutoverRecordCount > 0
        ? 'observed'
        : 'manual_required',
    },
    successfulPromotionSoak: {
      ...soak,
      minimumRequiredMs: RELEASE_PLAN_THRESHOLDS.minimumSuccessfulSoakMs,
      status: soak.sampleCount !== passedPromotionCount || passedPromotionCount === 0
        ? 'manual_required'
        : metricStatus(soakValues.every(
          (value) => value >= RELEASE_PLAN_THRESHOLDS.minimumSuccessfulSoakMs,
        )),
    },
    rollbackRecovery: {
      ...rollback,
      measurement: 'service_unavailable_to_healthy_predecessor',
      triggerToHealthy: durationSummary(rollbackTriggerValues),
      triggerToHealthyStatus: 'manual_required',
      targetMaxMs: RELEASE_PLAN_THRESHOLDS.rollbackRecoveryMaxMs,
      recoveryFailureReleaseIds: recoveryFailures,
      status: recoveryFailures.length > 0
        ? 'fail'
        : rollback.sampleCount === 0
          ? 'manual_required'
          : metricStatus(rollback.maxMs <= RELEASE_PLAN_THRESHOLDS.rollbackRecoveryMaxMs),
    },
    exactShaAndDigestParity: {
      releaseCount: validated.releases.length,
      exactMatchCount: validated.releases.length - parityFailures.length,
      failures: parityFailures,
      status: metricStatus(parityFailures.length === 0),
    },
    failedPromotions: {
      baselineReleaseCount: validated.baseline.releaseCount,
      baselineCount: validated.baseline.failedPromotions,
      currentReleaseCount: validated.releases.length,
      currentCount: failedPromotions,
      delta: failedPromotions - validated.baseline.failedPromotions,
      status: 'manual_required',
    },
    escapedReleaseDefects: {
      baselineReleaseCount: validated.baseline.releaseCount,
      baselineCount: validated.baseline.escapedReleaseDefects,
      currentReleaseCount: validated.releases.length,
      currentCount: escapedReleaseDefects,
      delta: escapedReleaseDefects - validated.baseline.escapedReleaseDefects,
      status: 'manual_required',
    },
  };

  const reasons = [];
  if (metrics.automatedReadiness.status === 'fail') reasons.push('automated_readiness_p50_above_9_minutes');
  if (metrics.unattendedHandoffDelay.status === 'fail') reasons.push('unattended_handoff_p50_above_1_minute');
  if (metrics.successfulPromotionSoak.status === 'fail') reasons.push('successful_promotion_soak_below_60_seconds');
  if (metrics.rollbackRecovery.status === 'fail') reasons.push('rollback_recovery_failed_or_above_120_seconds');
  if (metrics.exactShaAndDigestParity.status === 'fail') reasons.push('exact_sha_or_digest_parity_failed');
  if (metrics.failedPromotions.status === 'fail') reasons.push('failed_promotions_increased');
  if (metrics.escapedReleaseDefects.status === 'fail') reasons.push('escaped_release_defects_increased');
  if (metrics.actualUnavailability.status === 'not_observed') reasons.push('actual_unavailability_not_observed');
  if (metrics.rollbackRecovery.status === 'manual_required') reasons.push('rollback_recovery_not_observed');
  if (metrics.automatedReadiness.status === 'manual_required') {
    reasons.push('authoritative_automated_readiness_start_evidence_required');
  }
  if (validated.releases.some((release) => !release.authority.protectedMainCompletionExplicit)) {
    reasons.push('signed_protected_main_completion_evidence_required');
  }
  if (metrics.unattendedHandoffDelay.status === 'manual_required') {
    reasons.push('authoritative_handoff_timestamps_required');
  }
  if (metrics.successfulPromotionSoak.status === 'manual_required') {
    reasons.push('authoritative_soak_start_and_completion_required');
  }
  if (metrics.totalCutoverIncludingSoak.status === 'manual_required') {
    reasons.push('authoritative_total_cutover_start_required');
  }
  if (metrics.failedPromotions.status === 'manual_required') {
    reasons.push('authoritative_failed_promotion_baseline_required');
  }
  if (metrics.escapedReleaseDefects.status === 'manual_required') {
    reasons.push('authoritative_sentry_defect_evidence_required');
  }

  const hasFailure = Object.values(metrics).some((metric) => metric.status === 'fail');
  const hasManual = Object.values(metrics).some((metric) => metric.status === 'manual_required')
    || metrics.actualUnavailability.status === 'not_observed'
    || Object.values(metrics.automatedStageTimings).some((metric) => metric.status === 'manual_required');
  const verdict = hasFailure ? 'FAIL' : hasManual ? 'MANUAL_REQUIRED' : 'PASS';

  return {
    schema: RELEASE_PLAN_EVALUATION_SCHEMA,
    verdict,
    generatedAt: validated.generatedAt,
    releaseCount: validated.releases.length,
    thresholds: { ...RELEASE_PLAN_THRESHOLDS },
    metrics,
    reasons,
  };
}

function validatePositiveNumericString(value, label) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) fail(`${label} is invalid`);
}

function validateShadowComparison(comparison, label, expectedRuntimeSha, productionCompletedAt) {
  exactKeys(comparison, [
    'schema',
    'status',
    'reason',
    'reuseScope',
    'runtimeSha',
    'comparedAt',
    'mainCi',
    'releaseCi',
    'checks',
  ], label);
  if (comparison.schema !== RELEASE_SHADOW_COMPARISON_SCHEMA
      || comparison.reuseScope !== PROTECTED_MAIN_REUSE_SCOPE
      || !['eligible', 'ineligible'].includes(comparison.status)) {
    fail(`${label} schema, scope, or status is invalid`);
  }
  requireSha(comparison.runtimeSha, `${label}.runtimeSha`);
  if (comparison.runtimeSha !== expectedRuntimeSha) fail(`${label}.runtimeSha does not match its ledger entry`);
  const comparedAt = timestampMs(comparison.comparedAt, `${label}.comparedAt`);
  if (comparedAt > productionCompletedAt) fail(`${label}.comparedAt is after production completion`);
  exactKeys(comparison.checks, RELEASE_SHADOW_CHECKS, `${label}.checks`);
  if (Object.values(comparison.checks).some((value) => typeof value !== 'boolean')) {
    fail(`${label}.checks must all be boolean`);
  }
  const eligible = Object.values(comparison.checks).every(Boolean);
  if ((comparison.status === 'eligible') !== eligible
      || (eligible && comparison.reason !== null)
      || (!eligible && (typeof comparison.reason !== 'string' || !SAFE_ID_PATTERN.test(comparison.reason)))) {
    fail(`${label} status and checks are inconsistent`);
  }
  if (comparison.mainCi === null) {
    if (eligible) fail(`${label}.mainCi is required for an eligible comparison`);
  } else {
    exactKeys(comparison.mainCi, ['runId', 'runAttempt', 'artifactDigest'], `${label}.mainCi`);
    validatePositiveNumericString(comparison.mainCi.runId, `${label}.mainCi.runId`);
    validatePositiveNumericString(comparison.mainCi.runAttempt, `${label}.mainCi.runAttempt`);
    requireDigest(comparison.mainCi.artifactDigest, `${label}.mainCi.artifactDigest`);
  }
  exactKeys(comparison.releaseCi, ['runId', 'runAttempt'], `${label}.releaseCi`);
  validatePositiveNumericString(comparison.releaseCi.runId, `${label}.releaseCi.runId`);
  validatePositiveNumericString(comparison.releaseCi.runAttempt, `${label}.releaseCi.runAttempt`);
  return { eligible, comparedAt };
}

export function validateReleaseShadowLedger(ledger) {
  exactKeys(ledger, ['schema', 'generatedAt', 'entries'], 'release shadow ledger');
  if (ledger.schema !== RELEASE_SHADOW_LEDGER_SCHEMA) fail('release shadow ledger schema is unsupported');
  const generatedAt = timestampMs(ledger.generatedAt, 'release shadow ledger.generatedAt');
  if (!Array.isArray(ledger.entries) || ledger.entries.length !== SHADOW_COUNT) {
    fail(`release shadow ledger must contain exactly ${SHADOW_COUNT} production entries`);
  }
  const entries = ledger.entries.map((entry, index) => {
    const label = `release shadow ledger.entries[${index}]`;
    exactKeys(entry, [
      'productionSequence',
      'productionReleaseId',
      'productionRuntimeSha',
      'productionCompletedAt',
      'manifestSha256',
      'comparison',
    ], label);
    const productionSequence = requireSafeInteger(entry.productionSequence, `${label}.productionSequence`, {
      minimum: 1,
    });
    const productionReleaseId = requireSafeId(entry.productionReleaseId, `${label}.productionReleaseId`);
    const productionRuntimeSha = requireSha(entry.productionRuntimeSha, `${label}.productionRuntimeSha`);
    const productionCompletedAt = timestampMs(entry.productionCompletedAt, `${label}.productionCompletedAt`);
    const manifestSha256 = requireDigest(entry.manifestSha256, `${label}.manifestSha256`);
    const comparison = validateShadowComparison(
      entry.comparison,
      `${label}.comparison`,
      productionRuntimeSha,
      productionCompletedAt,
    );
    return {
      productionSequence,
      productionReleaseId,
      productionRuntimeSha,
      productionCompletedAt,
      manifestSha256,
      comparedAt: comparison.comparedAt,
      exactMatch: comparison.eligible,
    };
  });
  if (new Set(entries.map((entry) => entry.productionReleaseId)).size !== entries.length) {
    fail('release shadow ledger contains duplicate production release IDs');
  }
  if (new Set(entries.map((entry) => entry.productionRuntimeSha)).size !== entries.length) {
    fail('release shadow ledger contains duplicate runtime SHAs');
  }
  if (new Set(entries.map((entry) => entry.manifestSha256)).size !== entries.length) {
    fail('release shadow ledger contains duplicate manifest digests');
  }
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index].productionSequence !== entries[index - 1].productionSequence + 1) {
      fail('release shadow ledger production sequence must be consecutive');
    }
    if (entries[index].productionCompletedAt <= entries[index - 1].productionCompletedAt) {
      fail('release shadow ledger must be strictly chronological');
    }
    if (entries[index].comparedAt <= entries[index - 1].productionCompletedAt) {
      fail('release shadow comparisons must follow the preceding production release');
    }
  }
  if (generatedAt < entries.at(-1).productionCompletedAt) {
    fail('release shadow ledger was generated before its final production entry completed');
  }
  return { generatedAt: ledger.generatedAt, entries };
}

export function evaluateReleaseShadowReadiness(ledger) {
  const validated = validateReleaseShadowLedger(ledger);
  const fiveConsecutiveExactMatches = validated.entries.every((entry) => entry.exactMatch);
  const reasons = [];
  if (!fiveConsecutiveExactMatches) reasons.push('five_consecutive_exact_matches_required');
  reasons.push('independent_github_provenance_required');
  return {
    schema: RELEASE_SHADOW_READINESS_SCHEMA,
    verdict: 'MANUAL_REQUIRED',
    mode: 'shadow_only',
    generatedAt: validated.generatedAt,
    entryCount: validated.entries.length,
    fiveConsecutiveExactMatches,
    shadowRequirementMet: fiveConsecutiveExactMatches,
    independentGithubProvenanceVerified: false,
    activationAllowed: false,
    reasons,
  };
}
