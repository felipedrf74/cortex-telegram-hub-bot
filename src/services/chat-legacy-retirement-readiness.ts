// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export const NEXUS_CHAT_LEGACY_RETIREMENT_READINESS_VERSION = 'nexus_chat_legacy_retirement_readiness.v1';

export interface ChatLegacyRetirementThresholds {
  minShadowParityRate: number;
  minSamplesPerRoute: number;
  maxLegacyFallbackRate24h: number;
  requireFullVerifyClean: boolean;
}

export const DEFAULT_CHAT_LEGACY_RETIREMENT_THRESHOLDS: ChatLegacyRetirementThresholds = {
  minShadowParityRate: 0.95,
  minSamplesPerRoute: 50,
  maxLegacyFallbackRate24h: 0.02,
  requireFullVerifyClean: true,
};

export interface ChatLegacyRouteExitSample {
  routeId: string;
  replaced: boolean;
  tested: boolean;
  shadowParityRate: number;
  sampleCount: number;
  evaluator?: string;
  peerReviewSignoffHash?: string;
  safetyRegressionCount?: number;
  qualityRegressionCount?: number;
  degradedNotComparableCount?: number;
}

export interface ChatLegacyRetirementReadinessInput {
  routeSamples: ChatLegacyRouteExitSample[];
  legacyFallbackRate24h: number;
  fullVerifyClean: boolean;
  thresholds?: Partial<ChatLegacyRetirementThresholds>;
  requiredRouteIds?: string[];
}

export type ChatLegacyRetirementGateId =
  | 'route_exit_replacements'
  | 'route_shadow_parity'
  | 'route_independent_peer_review'
  | 'route_safety_regressions'
  | 'route_quality_regressions'
  | 'route_degraded_not_comparable'
  | 'legacy_fallback_rate'
  | 'full_verify_clean';

export interface ChatLegacyRetirementGateResult {
  gateId: ChatLegacyRetirementGateId;
  passed: boolean;
  sampleCount: number;
  observed: number;
  threshold: number;
  reasonCode?: string;
}

export interface ChatLegacyRetirementReadinessResult {
  version: typeof NEXUS_CHAT_LEGACY_RETIREMENT_READINESS_VERSION;
  passed: boolean;
  gates: ChatLegacyRetirementGateResult[];
}

export function evaluateChatLegacyRetirementReadiness(
  input: ChatLegacyRetirementReadinessInput,
): ChatLegacyRetirementReadinessResult {
  const thresholds = { ...DEFAULT_CHAT_LEGACY_RETIREMENT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const requiredRouteIds = input.requiredRouteIds ?? [];
  const gates = [
    evaluateRouteReplacements(input.routeSamples, requiredRouteIds),
    evaluateShadowParity(input.routeSamples, thresholds, requiredRouteIds),
    evaluateIndependentPeerReview(input.routeSamples, requiredRouteIds),
    evaluateSafetyRegressions(input.routeSamples, requiredRouteIds),
    evaluateQualityRegressions(input.routeSamples, requiredRouteIds),
    evaluateDegradedNotComparable(input.routeSamples, requiredRouteIds),
    evaluateLegacyFallbackRate(input.legacyFallbackRate24h, thresholds),
    evaluateFullVerify(input.fullVerifyClean, thresholds),
  ];
  return {
    version: NEXUS_CHAT_LEGACY_RETIREMENT_READINESS_VERSION,
    passed: gates.every((gate) => gate.passed),
    gates,
  };
}

function evaluateSafetyRegressions(
  samples: ChatLegacyRouteExitSample[],
  requiredRouteIds: string[],
): ChatLegacyRetirementGateResult {
  const sampleRouteIds = new Set(samples.map((sample) => sample.routeId));
  const missingRequired = requiredRouteIds.filter((routeId) => !sampleRouteIds.has(routeId));
  const missingReview = samples.filter((sample) => sample.safetyRegressionCount == null).length;
  const regressions = samples.filter((sample) => (sample.safetyRegressionCount ?? 0) > 0).length;
  const violations = missingReview + regressions + missingRequired.length;
  return {
    gateId: 'route_safety_regressions',
    passed: samples.length > 0 && violations === 0,
    sampleCount: samples.length,
    observed: violations,
    threshold: 0,
    reasonCode: samples.length > 0
      ? missingRequired.length > 0
        ? 'missing_required_route_exit_samples'
        : missingReview > 0
          ? 'missing_safety_regression_review'
          : regressions > 0
            ? 'chatv2_worse_safety_regression'
            : undefined
      : 'missing_safety_review_samples',
  };
}

function evaluateQualityRegressions(
  samples: ChatLegacyRouteExitSample[],
  requiredRouteIds: string[],
): ChatLegacyRetirementGateResult {
  const sampleRouteIds = new Set(samples.map((sample) => sample.routeId));
  const missingRequired = requiredRouteIds.filter((routeId) => !sampleRouteIds.has(routeId));
  const missingReview = samples.filter((sample) => sample.qualityRegressionCount == null).length;
  const regressions = samples.filter((sample) => (sample.qualityRegressionCount ?? 0) > 0).length;
  const violations = missingReview + regressions + missingRequired.length;
  return {
    gateId: 'route_quality_regressions',
    passed: samples.length > 0 && violations === 0,
    sampleCount: samples.length,
    observed: violations,
    threshold: 0,
    reasonCode: samples.length > 0
      ? missingRequired.length > 0
        ? 'missing_required_route_exit_samples'
        : missingReview > 0
          ? 'missing_quality_regression_review'
          : regressions > 0
            ? 'chatv2_worse_quality_regression'
            : undefined
      : 'missing_quality_review_samples',
  };
}

function evaluateDegradedNotComparable(
  samples: ChatLegacyRouteExitSample[],
  requiredRouteIds: string[],
): ChatLegacyRetirementGateResult {
  const sampleRouteIds = new Set(samples.map((sample) => sample.routeId));
  const missingRequired = requiredRouteIds.filter((routeId) => !sampleRouteIds.has(routeId));
  const missingReview = samples.filter((sample) => sample.degradedNotComparableCount == null).length;
  const degraded = samples.filter((sample) => (sample.degradedNotComparableCount ?? 0) > 0).length;
  const violations = missingReview + degraded + missingRequired.length;
  return {
    gateId: 'route_degraded_not_comparable',
    passed: samples.length > 0 && violations === 0,
    sampleCount: samples.length,
    observed: violations,
    threshold: 0,
    reasonCode: samples.length > 0
      ? missingRequired.length > 0
        ? 'missing_required_route_exit_samples'
        : missingReview > 0
          ? 'missing_degraded_not_comparable_review'
          : degraded > 0
            ? 'degraded_not_comparable_present'
            : undefined
      : 'missing_degraded_review_samples',
  };
}

function evaluateIndependentPeerReview(
  samples: ChatLegacyRouteExitSample[],
  requiredRouteIds: string[],
): ChatLegacyRetirementGateResult {
  const sampleRouteIds = new Set(samples.map((sample) => sample.routeId));
  const missingRequired = requiredRouteIds.filter((routeId) => !sampleRouteIds.has(routeId));
  const violations = samples.filter((sample) => !hasIndependentPeerReview(sample)).length + missingRequired.length;
  return {
    gateId: 'route_independent_peer_review',
    passed: samples.length > 0 && violations === 0,
    sampleCount: samples.length,
    observed: violations,
    threshold: 0,
    reasonCode: samples.length > 0
      ? missingRequired.length > 0 ? 'missing_required_route_exit_samples' : violations > 0 ? 'missing_independent_peer_review' : undefined
      : 'missing_peer_review_samples',
  };
}

function hasIndependentPeerReview(sample: ChatLegacyRouteExitSample): boolean {
  const evaluator = String(sample.evaluator ?? '').trim().toLowerCase();
  if (evaluator !== 'claude' && evaluator !== 'manual') return false;
  return /^[a-f0-9]{64}$/i.test(String(sample.peerReviewSignoffHash ?? '').trim());
}

function evaluateRouteReplacements(
  samples: ChatLegacyRouteExitSample[],
  requiredRouteIds: string[],
): ChatLegacyRetirementGateResult {
  const sampleRouteIds = new Set(samples.map((sample) => sample.routeId));
  const missingRequired = requiredRouteIds.filter((routeId) => !sampleRouteIds.has(routeId));
  const violations = samples.filter((sample) => !sample.replaced || !sample.tested).length;
  return {
    gateId: 'route_exit_replacements',
    passed: samples.length > 0 && violations === 0 && missingRequired.length === 0,
    sampleCount: samples.length,
    observed: violations + missingRequired.length,
    threshold: 0,
    reasonCode: samples.length > 0
      ? missingRequired.length > 0 ? 'missing_required_route_exit_samples' : undefined
      : 'missing_route_exit_samples',
  };
}

function evaluateShadowParity(
  samples: ChatLegacyRouteExitSample[],
  thresholds: ChatLegacyRetirementThresholds,
  requiredRouteIds: string[],
): ChatLegacyRetirementGateResult {
  const sampleRouteIds = new Set(samples.map((sample) => sample.routeId));
  const missingRequired = requiredRouteIds.filter((routeId) => !sampleRouteIds.has(routeId));
  const violations = samples.filter((sample) =>
    sample.sampleCount < thresholds.minSamplesPerRoute
    || sample.shadowParityRate < thresholds.minShadowParityRate,
  ).length + missingRequired.length;
  return {
    gateId: 'route_shadow_parity',
    passed: samples.length > 0 && violations === 0,
    sampleCount: samples.length,
    observed: violations,
    threshold: 0,
    reasonCode: samples.length > 0
      ? missingRequired.length > 0 ? 'missing_required_route_exit_samples' : undefined
      : 'missing_shadow_parity_samples',
  };
}

function evaluateLegacyFallbackRate(
  rate: number,
  thresholds: ChatLegacyRetirementThresholds,
): ChatLegacyRetirementGateResult {
  return {
    gateId: 'legacy_fallback_rate',
    passed: Number.isFinite(rate) && rate < thresholds.maxLegacyFallbackRate24h,
    sampleCount: 1,
    observed: rate,
    threshold: thresholds.maxLegacyFallbackRate24h,
    reasonCode: Number.isFinite(rate) ? undefined : 'missing_legacy_fallback_rate',
  };
}

function evaluateFullVerify(
  fullVerifyClean: boolean,
  thresholds: ChatLegacyRetirementThresholds,
): ChatLegacyRetirementGateResult {
  const observed = fullVerifyClean ? 1 : 0;
  return {
    gateId: 'full_verify_clean',
    passed: !thresholds.requireFullVerifyClean || fullVerifyClean,
    sampleCount: 1,
    observed,
    threshold: 1,
  };
}
