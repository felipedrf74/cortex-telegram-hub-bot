// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  CHAT_EVAL_EVIDENCE_REDACTION_VERSION,
  CHAT_EVAL_REDACTED_TEXT_MARKER,
  chatEvalEvidenceRawTextFindings,
  redactChatEvalEvidence,
} from '../../src/services/chat-eval-evidence-redaction';

function rawEvidenceFixture(): Record<string, unknown> {
  return {
    generatedAt: '2026-07-31T17:19:58.073Z',
    mode: 'real_provider',
    passed: false,
    averageScore: 1.3,
    scenarioCount: 2,
    statusCounts: { pass: 1, partial: 0, fail: 1, blocked: 0 },
    qualityMetrics: [{ id: 'm1', label: 'Metric', description: 'How it is measured', source: 's', privacy: 'aggregate', target: 't' }],
    scenarios: [
      {
        id: 'sc_a',
        title: 'Scenario A',
        personaId: 'persona_a',
        evidenceMode: 'live',
        status: 'fail',
        averageScore: 1.1,
        executed: true,
        scores: { routing_domain: 1 },
        failures: ['response said "buy oat milk at 7pm" but the task was not created'],
      },
    ],
    dayToDay: {
      generatedAt: '2026-07-31T17:19:58.073Z',
      mode: 'real_provider',
      passed: false,
      averageScore: 1.3,
      failureSummary: { tenant_leak: 0 },
      scenarios: [
        {
          scenarioId: 'sc_a',
          title: 'Scenario A',
          personaId: 'persona_a',
          passed: false,
          averageScore: 1.1,
          turns: [
            {
              turnId: 'sc_a_t1',
              scenarioId: 'sc_a',
              userMessage: 'remind me to buy oat milk at 7pm',
              activeTenantId: 4242,
              expectedLanguage: 'en',
              executionStatus: 'ok',
              passed: false,
              averageScore: 1.1,
              response: {
                text: 'I added "buy oat milk" to your list.',
                domain: 'secretary',
                actionStatus: 'completed',
                skillsUsed: ['tasks'],
                safetyNotes: ['no confirmation requested'],
                providerTrace: { provider: 'gemini', model: 'gemini-2.5-flash', category: 'chat', tier: 'primary', mode: 'live', fallbackUsed: false },
                iosEnvelope: {
                  id: 'env_1',
                  text: 'I added "buy oat milk" to your list.',
                  domain: 'secretary',
                  timestamp: '2026-07-31T17:20:00.000Z',
                  routeMethod: 'skill',
                  confidence: 0.9,
                  buttons: null,
                  metadata: null,
                },
              },
              scores: { correctness: 1, tenantSafety: 3, noCrossTenantLeakage: 3 },
              scorerDimensions: [
                { dimension: 'correctness', source: 'scorer', failureType: 'missing_tool_call', score: 1, passed: false, detail: 'expected a task create for "buy oat milk" but none was recorded' },
              ],
              failures: [
                { type: 'missing_tool_call', detail: 'no task was created for "buy oat milk"' },
              ],
            },
          ],
        },
      ],
      judge: {
        model: 'gemini-2.5-flash-lite',
        calls: 1,
        estimatedSpendUsd: 0.0001,
        aborted: false,
        scenarios: [
          {
            scenarioId: 'sc_a',
            status: 'failed',
            detail: 'failed',
            estimatedCostUsd: 0.0001,
            scores: {
              wording_quality: { score: 2, passed: false, rationale: 'The reply claims "buy oat milk" was added without verifying.' },
              groundedness: { score: 1, passed: false, rationale: 'Claims a task exists that was never created.' },
              sufficiency: { score: 1, passed: false, rationale: 'Does not tell the user the action failed.' },
              explanation_quality: { score: 2, passed: false, rationale: 'No explanation of what happened.' },
            },
          },
        ],
      },
    },
    judge: {
      model: 'gemini-2.5-flash-lite',
      calls: 1,
      estimatedSpendUsd: 0.0001,
      aborted: false,
      scenarios: [
        {
          scenarioId: 'sc_a',
          status: 'failed',
          detail: 'failed',
          estimatedCostUsd: 0.0001,
          scores: {
            wording_quality: { score: 2, passed: false, rationale: 'The reply claims "buy oat milk" was added without verifying.' },
            groundedness: { score: 1, passed: false, rationale: 'Claims a task exists that was never created.' },
            sufficiency: { score: 1, passed: false, rationale: 'Does not tell the user the action failed.' },
            explanation_quality: { score: 2, passed: false, rationale: 'No explanation of what happened.' },
          },
        },
      ],
    },
    preflightAttestation: { contractVersion: 'chat-live-eval-v1', mode: 'real_provider', runId: 'run_1', productionDataUsed: false, seedProfileVersion: 'sp@1', supportedScenarioIds: ['sc_a'] },
    costAttestation: { contractVersion: 'chat-live-eval-v1', attested: true, reasons: [], totalActualSpendUsd: 0.0009 },
  };
}

const SOURCE_SHA = 'a'.repeat(64);

describe('chat eval evidence redaction', () => {
  it('removes every free-text field derived from a turn, response, or provider judge output', () => {
    const { redacted } = redactChatEvalEvidence(rawEvidenceFixture(), SOURCE_SHA);
    const turn = (redacted as any).dayToDay.scenarios[0].turns[0];

    expect(turn.userMessage).toBe(CHAT_EVAL_REDACTED_TEXT_MARKER);
    expect(turn.response.text).toBe(CHAT_EVAL_REDACTED_TEXT_MARKER);
    expect(turn.response.iosEnvelope.text).toBe(CHAT_EVAL_REDACTED_TEXT_MARKER);
    expect(turn.response.safetyNotes).toEqual([CHAT_EVAL_REDACTED_TEXT_MARKER]);
    expect(turn.scorerDimensions[0].detail).toBe(CHAT_EVAL_REDACTED_TEXT_MARKER);
    expect(turn.failures[0].detail).toBe(CHAT_EVAL_REDACTED_TEXT_MARKER);
    expect((redacted as any).scenarios[0].failures).toEqual([CHAT_EVAL_REDACTED_TEXT_MARKER]);

    for (const root of ['judge', 'dayToDay'] as const) {
      const judge = root === 'judge' ? (redacted as any).judge : (redacted as any).dayToDay.judge;
      for (const dimension of ['wording_quality', 'groundedness', 'sufficiency', 'explanation_quality']) {
        expect(judge.scenarios[0].scores[dimension].rationale).toBe(CHAT_EVAL_REDACTED_TEXT_MARKER);
      }
    }
  });

  it('drops the per-turn tenant identifier', () => {
    const { redacted } = redactChatEvalEvidence(rawEvidenceFixture(), SOURCE_SHA);
    expect((redacted as any).dayToDay.scenarios[0].turns[0].activeTenantId).toBeNull();
  });

  it('preserves every metric, identity, and categorical field the evidence contract needs', () => {
    const raw = rawEvidenceFixture();
    const { redacted } = redactChatEvalEvidence(raw, SOURCE_SHA);
    const r = redacted as any;

    expect(r.averageScore).toBe(1.3);
    expect(r.scenarioCount).toBe(2);
    expect(r.statusCounts).toEqual({ pass: 1, partial: 0, fail: 1, blocked: 0 });
    expect(r.passed).toBe(false);
    expect(r.mode).toBe('real_provider');
    expect(r.generatedAt).toBe('2026-07-31T17:19:58.073Z');
    expect(r.costAttestation).toEqual((raw as any).costAttestation);
    expect(r.preflightAttestation).toEqual((raw as any).preflightAttestation);
    expect(r.qualityMetrics).toEqual((raw as any).qualityMetrics);

    const turn = r.dayToDay.scenarios[0].turns[0];
    expect(turn.scores).toEqual({ correctness: 1, tenantSafety: 3, noCrossTenantLeakage: 3 });
    expect(turn.response.providerTrace).toEqual((raw as any).dayToDay.scenarios[0].turns[0].response.providerTrace);
    expect(turn.response.domain).toBe('secretary');
    expect(turn.response.skillsUsed).toEqual(['tasks']);
    expect(turn.response.iosEnvelope.routeMethod).toBe('skill');
    expect(turn.response.iosEnvelope.confidence).toBe(0.9);
    expect(turn.scorerDimensions[0]).toMatchObject({
      dimension: 'correctness',
      source: 'scorer',
      failureType: 'missing_tool_call',
      score: 1,
      passed: false,
    });
    expect(turn.failures[0].type).toBe('missing_tool_call');
    expect(r.judge.scenarios[0].scores.groundedness.score).toBe(1);
    expect(r.judge.scenarios[0].estimatedCostUsd).toBe(0.0001);
  });

  it('records a deterministic manifest bound to the source archive digest', () => {
    const { manifest } = redactChatEvalEvidence(rawEvidenceFixture(), SOURCE_SHA);

    expect(manifest.redactionVersion).toBe(CHAT_EVAL_EVIDENCE_REDACTION_VERSION);
    expect(manifest.sourceSha256).toBe(SOURCE_SHA);
    expect(manifest.totalRemovedOccurrences).toBeGreaterThan(0);
    expect(manifest.totalRemovedTextBytes).toBeGreaterThan(0);
    const paths = manifest.removed.map((entry) => entry.path);
    expect(paths).toContain('dayToDay.scenarios[].turns[].userMessage');
    expect(paths).toContain('judge.scenarios[].scores.*.rationale');
    for (const entry of manifest.removed) {
      expect(entry.occurrences).toBeGreaterThan(0);
    }
  });

  it('is deterministic and idempotent', () => {
    const first = redactChatEvalEvidence(rawEvidenceFixture(), SOURCE_SHA);
    const second = redactChatEvalEvidence(rawEvidenceFixture(), SOURCE_SHA);
    expect(JSON.stringify(first.redacted)).toBe(JSON.stringify(second.redacted));
    expect(first.manifest).toEqual(second.manifest);

    const twice = redactChatEvalEvidence(first.redacted, SOURCE_SHA);
    expect(JSON.stringify(twice.redacted)).toBe(JSON.stringify(first.redacted));
  });

  it('does not mutate the caller-owned raw evidence', () => {
    const raw = rawEvidenceFixture();
    const before = JSON.stringify(raw);
    redactChatEvalEvidence(raw, SOURCE_SHA);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('reports raw-text findings for unredacted evidence and none after redaction', () => {
    const raw = rawEvidenceFixture();
    expect(chatEvalEvidenceRawTextFindings(raw).length).toBeGreaterThan(0);

    const { redacted } = redactChatEvalEvidence(raw, SOURCE_SHA);
    expect(chatEvalEvidenceRawTextFindings(redacted)).toEqual([]);
  });

  it('tolerates evidence that omits optional collections', () => {
    const sparse = { generatedAt: 'x', mode: 'fixture', scenarios: [], dayToDay: { scenarios: [] } };
    const { redacted, manifest } = redactChatEvalEvidence(sparse, SOURCE_SHA);
    expect(redacted).toEqual(sparse);
    expect(manifest.totalRemovedOccurrences).toBe(0);
    expect(chatEvalEvidenceRawTextFindings(redacted)).toEqual([]);
  });
});
