// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  evaluateChatLegacyRetirementReadiness,
  type ChatLegacyRetirementGateId,
} from '../../src/services/chat-legacy-retirement-readiness';

const PEER_REVIEW_SIGNOFF_HASH = 'a'.repeat(64);

describe('evaluateChatLegacyRetirementReadiness', () => {
  it('passes when every legacy route exit is replaced, tested, and parity-qualified', () => {
    const result = evaluateChatLegacyRetirementReadiness({
      routeSamples: [
        route('secretary.read_today'),
        route('tasks.summary'),
      ],
      legacyFallbackRate24h: 0.01,
      fullVerifyClean: true,
    });

    expect(result.passed).toBe(true);
    expect(result.gates.map((gate) => [gate.gateId, gate.passed])).toEqual([
      ['route_exit_replacements', true],
      ['route_shadow_parity', true],
      ['route_independent_peer_review', true],
      ['route_safety_regressions', true],
      ['route_quality_regressions', true],
      ['route_degraded_not_comparable', true],
      ['legacy_fallback_rate', true],
      ['full_verify_clean', true],
    ]);
  });

  it('fails if any route inventory row is not replaced or not tested', () => {
    const result = evaluateChatLegacyRetirementReadiness({
      routeSamples: [
        route('secretary.read_today'),
        route('legacy.generic_secretary', { replaced: false }),
        route('legacy.cooking', { tested: false }),
      ],
      legacyFallbackRate24h: 0.01,
      fullVerifyClean: true,
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'route_exit_replacements')).toMatchObject({
      passed: false,
      observed: 2,
    });
  });

  it('fails if any replaced row lacks enough samples or shadow parity', () => {
    const result = evaluateChatLegacyRetirementReadiness({
      routeSamples: [
        route('secretary.read_today', { sampleCount: 49 }),
        route('tasks.summary', { shadowParityRate: 0.94 }),
      ],
      legacyFallbackRate24h: 0.01,
      fullVerifyClean: true,
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'route_shadow_parity')).toMatchObject({
      passed: false,
      observed: 2,
    });
  });

  it('fails both route and parity gates when a required legacy route is missing', () => {
    const result = evaluateChatLegacyRetirementReadiness({
      routeSamples: [route('secretary.read_today')],
      requiredRouteIds: ['secretary.read_today', 'domain_handler_execution'],
      legacyFallbackRate24h: 0.01,
      fullVerifyClean: true,
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'route_exit_replacements')).toMatchObject({
      passed: false,
      reasonCode: 'missing_required_route_exit_samples',
      observed: 1,
    });
    expect(gate(result, 'route_shadow_parity')).toMatchObject({
      passed: false,
      reasonCode: 'missing_required_route_exit_samples',
      observed: 1,
    });
    expect(gate(result, 'route_independent_peer_review')).toMatchObject({
      passed: false,
      reasonCode: 'missing_required_route_exit_samples',
      observed: 1,
    });
    expect(gate(result, 'route_safety_regressions')).toMatchObject({
      passed: false,
      reasonCode: 'missing_required_route_exit_samples',
      observed: 1,
    });
    expect(gate(result, 'route_quality_regressions')).toMatchObject({
      passed: false,
      reasonCode: 'missing_required_route_exit_samples',
      observed: 1,
    });
    expect(gate(result, 'route_degraded_not_comparable')).toMatchObject({
      passed: false,
      reasonCode: 'missing_required_route_exit_samples',
      observed: 1,
    });
  });

  it('fails when route parity is self-attested instead of independently reviewed', () => {
    const result = evaluateChatLegacyRetirementReadiness({
      routeSamples: [
        route('secretary.read_today', {
          evaluator: 'runtime_tool',
          peerReviewSignoffHash: undefined,
        }),
      ],
      legacyFallbackRate24h: 0.01,
      fullVerifyClean: true,
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'route_independent_peer_review')).toMatchObject({
      passed: false,
      reasonCode: 'missing_independent_peer_review',
      observed: 1,
      threshold: 0,
    });
  });

  it('fails when any reviewed route has a ChatV2-worse safety regression', () => {
    const result = evaluateChatLegacyRetirementReadiness({
      routeSamples: [
        route('secretary.read_today'),
        route('general_action_planner', { safetyRegressionCount: 1 }),
      ],
      legacyFallbackRate24h: 0.01,
      fullVerifyClean: true,
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'route_safety_regressions')).toMatchObject({
      passed: false,
      reasonCode: 'chatv2_worse_safety_regression',
      observed: 1,
      threshold: 0,
    });
  });

  it('fails when an otherwise passing route lacks quality/degraded review metadata', () => {
    const result = evaluateChatLegacyRetirementReadiness({
      routeSamples: [
        route('secretary.read_today', {
          qualityRegressionCount: undefined,
          degradedNotComparableCount: undefined,
        }),
      ],
      legacyFallbackRate24h: 0.01,
      fullVerifyClean: true,
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'route_quality_regressions')).toMatchObject({
      passed: false,
      reasonCode: 'missing_quality_regression_review',
      observed: 1,
      threshold: 0,
    });
    expect(gate(result, 'route_degraded_not_comparable')).toMatchObject({
      passed: false,
      reasonCode: 'missing_degraded_not_comparable_review',
      observed: 1,
      threshold: 0,
    });
  });

  it('fails when any reviewed route has worse quality or degraded-not-comparable samples', () => {
    const result = evaluateChatLegacyRetirementReadiness({
      routeSamples: [
        route('training_plan_shortcut', { qualityRegressionCount: 1 }),
        route('selective_internet_research', { degradedNotComparableCount: 1 }),
      ],
      legacyFallbackRate24h: 0.01,
      fullVerifyClean: true,
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'route_quality_regressions')).toMatchObject({
      passed: false,
      reasonCode: 'chatv2_worse_quality_regression',
      observed: 1,
      threshold: 0,
    });
    expect(gate(result, 'route_degraded_not_comparable')).toMatchObject({
      passed: false,
      reasonCode: 'degraded_not_comparable_present',
      observed: 1,
      threshold: 0,
    });
  });


  it('fails when the 24h legacy fallback rate is at or above two percent', () => {
    const result = evaluateChatLegacyRetirementReadiness({
      routeSamples: [route('secretary.read_today')],
      legacyFallbackRate24h: 0.02,
      fullVerifyClean: true,
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'legacy_fallback_rate')).toMatchObject({
      passed: false,
      observed: 0.02,
      threshold: 0.02,
    });
  });

  it('fails unless full verify is clean', () => {
    const result = evaluateChatLegacyRetirementReadiness({
      routeSamples: [route('secretary.read_today')],
      legacyFallbackRate24h: 0.01,
      fullVerifyClean: false,
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'full_verify_clean')).toMatchObject({
      passed: false,
      observed: 0,
      threshold: 1,
    });
  });
});

function route(
  routeId: string,
  overrides: Partial<Parameters<typeof evaluateChatLegacyRetirementReadiness>[0]['routeSamples'][number]> = {},
) {
  return {
    routeId,
    replaced: true,
    tested: true,
    shadowParityRate: 0.96,
    sampleCount: 50,
    evaluator: 'claude',
    peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
    safetyRegressionCount: 0,
    qualityRegressionCount: 0,
    degradedNotComparableCount: 0,
    ...overrides,
  };
}

function gate(
  result: ReturnType<typeof evaluateChatLegacyRetirementReadiness>,
  gateId: ChatLegacyRetirementGateId,
) {
  const found = result.gates.find((item) => item.gateId === gateId);
  expect(found).toBeDefined();
  return found!;
}
