// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHAT_V2_LEGACY_PARITY_LABEL_VERSION,
  CHAT_V2_LEGACY_PARITY_OBSERVATION_VERSION,
  CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
  aggregateChatV2LegacyParityObservations,
  buildChatV2LegacyParityEvidenceInput,
  buildChatV2RetirementObserverCorpusBinding,
  deleteExactCurrentChatV2RetirementEvidenceRows,
  hasExactCurrentChatV2RetirementObserverCorpusBinding,
  hasRetirementEligibleExactCurrentChatV2ObserverCorpusBinding,
  validateChatV2LegacyParityLabel,
  validateChatV2LegacyParityObservation,
} from '../../src/services/chat-legacy-parity-labels';
import {
  CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META,
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META,
} from '../../src/services/chat-legacy-parity-route-prompts';

const PEER_REVIEW_SIGNOFF_HASH = 'b'.repeat(64);

const ZERO_REVIEW_COUNTS = {
  safetyRegressionCount: 0,
  qualityRegressionCount: 0,
  degradedNotComparableCount: 0,
  reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
} as const;

describe('chat-legacy-parity-labels', () => {
  it('binds retirement evidence to the frozen v1.4 supported-locale projection, never v1.5', () => {
    const routeId = 'training_plan_shortcut';
    const binding = buildChatV2RetirementObserverCorpusBinding([routeId]);

    expect(hasExactCurrentChatV2RetirementObserverCorpusBinding(binding, routeId)).toBe(true);
    expect(CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META.frozenBeforeImplementation).toBe(false);
    expect(binding).toMatchObject({
      routePromptVersion: CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.version,
      routeCorpusId: CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.corpusId,
      routeCorpusFrozenBeforeImplementation: true,
    });
    expect(
      hasRetirementEligibleExactCurrentChatV2ObserverCorpusBinding(binding, routeId),
    ).toBe(true);
    expect(hasExactCurrentChatV2RetirementObserverCorpusBinding({
      ...binding,
      routePromptVersion: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META.version,
      routeCorpusId: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META.corpusId,
      routeCorpusFrozenBeforeImplementation: false,
    }, routeId)).toBe(false);
  });

  it('replaces only exact-current imported rows in the requested route scope', () => {
    const db = new Database(':memory:');
    try {
      db.exec(fs.readFileSync(
        path.resolve(__dirname, '../../migrations/160_chatv2_legacy_retirement_evidence.sql'),
        'utf8',
      ));
      const routeId = 'training_plan_shortcut';
      const otherRouteId = 'general_action_planner';
      const exactBinding = buildChatV2RetirementObserverCorpusBinding([routeId]);
      const otherBinding = buildChatV2RetirementObserverCorpusBinding([otherRouteId]);
      const insert = db.prepare(`
        INSERT INTO chat_v2_legacy_retirement_evidence (
          evidence_source, evidence_kind, request_id, sample_hmac, sample_identifier_kind,
          route_id, replaced, tested, shadow_parity_rate, route_sample_count,
          raw_field_audit_count, safe_metadata_json
        ) VALUES ('runtime_route', 'route_exit', ?, ?, 'hmac', ?, 1, 1, 0.98, 50, 0, ?)
      `);
      insert.run(
        'current-label-target',
        `hmac:test:${'1'.repeat(64)}`,
        routeId,
        JSON.stringify({ parityLabelImport: true, ...exactBinding }),
      );
      const historicalMetadata = JSON.stringify({
        parityLabelImport: true,
        routePromptVersion: 'chat_v2_legacy_parity_route_prompts@1.4.0',
        routeCorpusId: 'chatv2_phase7_route_replacement_heldout',
        routeCorpusSha256: '2'.repeat(64),
        observerRouteIds: [routeId],
        immutableAuditMarker: 'preserve-byte-for-byte',
      });
      insert.run(
        'historical-label-target',
        `hmac:test:${'2'.repeat(64)}`,
        routeId,
        historicalMetadata,
      );
      insert.run(
        'current-observation-target',
        `hmac:test:${'3'.repeat(64)}`,
        routeId,
        JSON.stringify({ parityObservationImport: true, ...exactBinding }),
      );
      insert.run(
        'current-label-other-route',
        `hmac:test:${'4'.repeat(64)}`,
        otherRouteId,
        JSON.stringify({ parityLabelImport: true, ...otherBinding }),
      );

      const deleted = deleteExactCurrentChatV2RetirementEvidenceRows(db, {
        evidenceSource: 'runtime_route',
        routeIds: [routeId],
        importMarker: 'parityLabelImport',
      });
      expect(deleted).toBe(1);

      const rows = db.prepare(`
        SELECT request_id, route_id, safe_metadata_json
        FROM chat_v2_legacy_retirement_evidence
        ORDER BY id
      `).all() as Array<{
        request_id: string;
        route_id: string;
        safe_metadata_json: string;
      }>;
      expect(rows.map((row) => row.request_id)).toEqual([
        'historical-label-target',
        'current-observation-target',
        'current-label-other-route',
      ]);
      expect(rows[0]!.safe_metadata_json).toBe(historicalMetadata);
    } finally {
      db.close();
    }
  });

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
