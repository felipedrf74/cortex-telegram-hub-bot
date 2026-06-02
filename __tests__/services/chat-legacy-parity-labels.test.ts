// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
  CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION,
  CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
  aggregateChatV2LegacyParityObservations,
  buildChatV2LegacyParityEvidenceInput,
  validateChatV2LegacyParityLabel,
  validateChatV2LegacyParityObservation,
} from '../../src/services/chat-legacy-parity-labels';

const PEER_REVIEW_SIGNOFF_HASH = 'b'.repeat(64);

const ZERO_REVIEW_COUNTS = {
  safetyRegressionCount: 0,
  qualityRegressionCount: 0,
  degradedNotComparableCount: 0,
  reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
} as const;

describe('chat-legacy-parity-labels', () => {
  it('accepts aggregate route parity labels and derives the parity rate', () => {
    const validation = validateChatV2LegacyParityLabel({
      schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
      routeId: 'domain_handler_execution',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'domain handlers',
      replacement: 'chatv2.domain_adapter',
      evaluator: 'claude',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      evidenceSource: 'runtime_route',
      ...ZERO_REVIEW_COUNTS,
    });

    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const evidence = buildChatV2LegacyParityEvidenceInput({
      label: validation.label,
      requestId: 'req-parity',
    });
    expect(evidence).toMatchObject({
      routeId: 'domain_handler_execution',
      replaced: true,
      tested: true,
      shadowParityRate: 0.98,
      sampleCount: 50,
      evidenceSource: 'runtime_route',
    });
    expect(evidence.safeMetadata).toMatchObject({
      parityLabelImport: true,
      evaluator: 'claude',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      matchingCount: 49,
      sampleCount: 50,
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 0,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    });
  });

  it('rejects labels with raw prompt/response/message fields', () => {
    for (const unsafe of [
      { rawText: 'cancel that' },
      { prompt: 'user prompt' },
      { responseText: 'assistant response' },
      { nested: { messageBody: 'private message' } },
    ]) {
      const validation = validateChatV2LegacyParityLabel({
        schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
        routeId: 'domain_handler_execution',
        replaced: true,
        tested: true,
        sampleCount: 50,
        matchingCount: 50,
        oldOwner: 'domain handlers',
        replacement: 'chatv2.domain_adapter',
        evaluator: 'manual',
        peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
        ...ZERO_REVIEW_COUNTS,
        ...unsafe,
      });
      expect(validation).toMatchObject({ ok: false });
    }
  });

  it('rejects invalid counts and route identifiers', () => {
    expect(validateChatV2LegacyParityLabel({
      schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
      routeId: 'Domain Handler',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'domain handlers',
      replacement: 'chatv2.domain_adapter',
      evaluator: 'manual',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      ...ZERO_REVIEW_COUNTS,
    })).toMatchObject({ ok: false, reason: 'invalid_route_id' });

    expect(validateChatV2LegacyParityLabel({
      schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
      routeId: 'domain_handler_execution',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 51,
      oldOwner: 'domain handlers',
      replacement: 'chatv2.domain_adapter',
      evaluator: 'manual',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      ...ZERO_REVIEW_COUNTS,
    })).toMatchObject({ ok: false, reason: 'invalid_matching_count' });
  });

  it('requires peer-review signoff hashes for independent evaluator labels', () => {
    expect(validateChatV2LegacyParityLabel({
      schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
      routeId: 'domain_handler_execution',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'domain handlers',
      replacement: 'chatv2.domain_adapter',
      evaluator: 'claude',
      evidenceSource: 'runtime_route',
      ...ZERO_REVIEW_COUNTS,
    })).toMatchObject({ ok: false, reason: 'missing_peer_review_signoff_hash' });

    expect(validateChatV2LegacyParityLabel({
      schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
      routeId: 'domain_handler_execution',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'domain handlers',
      replacement: 'chatv2.domain_adapter',
      evaluator: 'runtime_tool',
      evidenceSource: 'runtime_route',
    })).toMatchObject({ ok: true });
  });

  it('requires independent runtime labels to include zero safety regressions', () => {
    expect(validateChatV2LegacyParityLabel({
      schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
      routeId: 'domain_handler_execution',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'domain handlers',
      replacement: 'chatv2.domain_adapter',
      evaluator: 'claude',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
    })).toMatchObject({ ok: false, reason: 'missing_safety_regression_count' });

    expect(validateChatV2LegacyParityLabel({
      schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
      routeId: 'domain_handler_execution',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'domain handlers',
      replacement: 'chatv2.domain_adapter',
      evaluator: 'claude',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      safetyRegressionCount: 1,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 0,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    })).toMatchObject({ ok: false, reason: 'safety_regression_count_nonzero' });
  });

  it('requires independent runtime labels to include zero quality and degraded-not-comparable counts', () => {
    expect(validateChatV2LegacyParityLabel({
      schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
      routeId: 'selective_internet_research',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'research router',
      replacement: 'ChatV2 research adapter',
      evaluator: 'claude',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      safetyRegressionCount: 0,
      qualityRegressionCount: 1,
      degradedNotComparableCount: 0,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    })).toMatchObject({ ok: false, reason: 'quality_regression_count_nonzero' });

    expect(validateChatV2LegacyParityLabel({
      schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
      routeId: 'selective_internet_research',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'research router',
      replacement: 'ChatV2 research adapter',
      evaluator: 'manual',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 1,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    })).toMatchObject({ ok: false, reason: 'degraded_not_comparable_count_nonzero' });

    expect(validateChatV2LegacyParityLabel({
      schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
      routeId: 'selective_internet_research',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'research router',
      replacement: 'ChatV2 research adapter',
      evaluator: 'claude',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      safetyRegressionCount: 0,
      qualityRegressionCount: -1,
      degradedNotComparableCount: 0,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    })).toMatchObject({ ok: false, reason: 'invalid_quality_regression_count' });

    expect(validateChatV2LegacyParityLabel({
      schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
      routeId: 'selective_internet_research',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'research router',
      replacement: 'ChatV2 research adapter',
      evaluator: 'manual',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 51,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    })).toMatchObject({ ok: false, reason: 'invalid_degraded_not_comparable_count' });
  });

  it('accepts HMAC-only parity observations and aggregates them into labels', () => {
    const observations = Array.from({ length: 50 }, (_, index) => {
      const validation = validateChatV2LegacyParityObservation({
        schemaVersion: CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION,
        routeId: 'domain_handler_execution',
        sampleHmac: `hmac:legacy-sample:${String(index).padStart(64, 'a').slice(0, 64)}`,
        matched: index !== 49,
        tested: true,
        oldOwner: 'domain handlers',
        replacement: 'chatv2.domain_adapter',
        evaluator: 'claude',
        peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
        evidenceSource: 'runtime_route',
        reasonCode: index === 49 ? 'safe_mismatch' : 'match',
        safetyVerdict: index === 49 ? 'equivalent_different' : 'match',
        safetyDimension: 'none',
        reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
      });
      expect(validation.ok).toBe(true);
      if (!validation.ok) throw new Error(validation.reason);
      return validation.observation;
    });

    const [aggregate] = aggregateChatV2LegacyParityObservations(observations);

    expect(aggregate).toMatchObject({
      routeId: 'domain_handler_execution',
      label: {
        schemaVersion: CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
        replaced: true,
        tested: true,
        sampleCount: 50,
        matchingCount: 50,
        peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
        safetyRegressionCount: 0,
        qualityRegressionCount: 0,
        degradedNotComparableCount: 0,
        reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
      },
    });
  });

  it('blocks aggregate labels when any observation is ChatV2-worse on a safety dimension', () => {
    const safe = validateChatV2LegacyParityObservation({
      schemaVersion: CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION,
      routeId: 'general_action_planner',
      sampleHmac: `hmac:legacy-sample:${'c'.repeat(64)}`,
      matched: true,
      tested: true,
      oldOwner: 'chat-action-planner.ts',
      replacement: 'ChatV2 command preview',
      evaluator: 'claude',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      evidenceSource: 'runtime_route',
      safetyVerdict: 'match',
      safetyDimension: 'none',
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    });
    const worse = validateChatV2LegacyParityObservation({
      schemaVersion: CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION,
      routeId: 'general_action_planner',
      sampleHmac: `hmac:legacy-sample:${'d'.repeat(64)}`,
      matched: false,
      tested: true,
      oldOwner: 'chat-action-planner.ts',
      replacement: 'ChatV2 command preview',
      evaluator: 'claude',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      evidenceSource: 'runtime_route',
      reasonCode: 'false_success_claim',
      safetyVerdict: 'chatv2_worse_safety',
      safetyDimension: 'success_claim',
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    });
    expect(safe.ok).toBe(true);
    expect(worse.ok).toBe(true);
    if (!safe.ok || !worse.ok) return;

    const [aggregate] = aggregateChatV2LegacyParityObservations([safe.observation, worse.observation]);

    expect(aggregate).toMatchObject({
      routeId: 'general_action_planner',
      blockedReason: 'chatv2_worse_safety_regression:success_claim',
      label: {
        replaced: false,
        tested: false,
        sampleCount: 2,
        matchingCount: 1,
        safetyRegressionCount: 1,
        qualityRegressionCount: 0,
        degradedNotComparableCount: 0,
      },
    });
  });

  it('blocks aggregate labels when Claude finds worse quality or degraded-not-comparable answers', () => {
    const worseQuality = validateChatV2LegacyParityObservation({
      schemaVersion: CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION,
      routeId: 'selective_internet_research',
      sampleHmac: `hmac:legacy-sample:${'e'.repeat(64)}`,
      matched: false,
      tested: true,
      oldOwner: 'research router',
      replacement: 'ChatV2 research adapter',
      evaluator: 'claude',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      evidenceSource: 'runtime_route',
      reasonCode: 'answer_materially_worse',
      safetyVerdict: 'chatv2_worse_quality',
      safetyDimension: 'answer_quality',
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    });
    const degraded = validateChatV2LegacyParityObservation({
      schemaVersion: CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION,
      routeId: 'domain_handler_execution',
      sampleHmac: `hmac:legacy-sample:${'f'.repeat(64)}`,
      matched: true,
      tested: true,
      oldOwner: 'domain handlers',
      replacement: 'domain adapters command bus',
      evaluator: 'manual',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      evidenceSource: 'runtime_route',
      reasonCode: 'mutual_degraded',
      safetyVerdict: 'not_comparable_degraded',
      safetyDimension: 'answer_quality',
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    });
    expect(worseQuality.ok).toBe(true);
    expect(degraded.ok).toBe(true);
    if (!worseQuality.ok || !degraded.ok) return;

    expect(aggregateChatV2LegacyParityObservations([worseQuality.observation])[0]).toMatchObject({
      blockedReason: 'chatv2_worse_quality_regression:answer_quality',
      label: { qualityRegressionCount: 1 },
    });
    expect(aggregateChatV2LegacyParityObservations([degraded.observation])[0]).toMatchObject({
      blockedReason: 'not_comparable_degraded:answer_quality',
      label: { degradedNotComparableCount: 1 },
    });
  });

  it('rejects parity observations with raw private fields', () => {
    const validation = validateChatV2LegacyParityObservation({
      schemaVersion: CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION,
      routeId: 'domain_handler_execution',
      sampleHmac: `hmac:legacy-sample:${'a'.repeat(64)}`,
      matched: true,
      tested: true,
      oldOwner: 'domain handlers',
      replacement: 'chatv2.domain_adapter',
      evaluator: 'manual',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
      rawResponse: 'private response',
    });

    expect(validation).toMatchObject({ ok: false, reason: 'unsafe_field_key:rawResponse' });
  });

  it('blocks conflicting duplicate parity observations during aggregation', () => {
    const base = {
      schemaVersion: CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION,
      routeId: 'domain_handler_execution',
      sampleHmac: `hmac:legacy-sample:${'b'.repeat(64)}`,
      tested: true,
      oldOwner: 'domain handlers',
      replacement: 'chatv2.domain_adapter',
      evaluator: 'manual',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    } as const;
    const first = validateChatV2LegacyParityObservation({ ...base, matched: true });
    const second = validateChatV2LegacyParityObservation({ ...base, matched: false });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const [aggregate] = aggregateChatV2LegacyParityObservations([first.observation, second.observation]);

    expect(aggregate).toMatchObject({
      routeId: 'domain_handler_execution',
      blockedReason: `conflicting_duplicate_sample:${base.sampleHmac}`,
    });
  });
});
