// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  evaluateChatAnswerCanaryExit,
  type ChatAnswerCanaryAcceptanceSample,
  type ChatAnswerCanaryCompositionSample,
  type ChatAnswerCanaryProgressSample,
  type ChatAnswerCanaryPrivacySample,
  type ChatAnswerCanaryUnsupportedClaimSample,
} from '../../src/services/chat-answer-canary-exit';

describe('evaluateChatAnswerCanaryExit', () => {
  it('passes when all answer-only canary gates meet the Work Order thresholds', () => {
    const result = evaluateChatAnswerCanaryExit({
      acceptanceSamples: [
        ...acceptance('en', 10, 9),
        ...acceptance('pt-BR', 20, 17),
        ...acceptance('pt-PT', 10, 8),
        ...acceptance('mixed', 4, 3),
      ],
      unsupportedClaimSamples: unsupportedClaims(20, 19),
      progressSamples: progress([400, 850, 1_100, 1_700, 2_000]),
      privacySamples: privacy([false, false, false]),
      compositionSamples: composition(20, 7),
    });

    expect(result.passed).toBe(true);
    expect(result.gates.map((gate) => [gate.gateId, gate.passed])).toEqual([
      ['answer_acceptance_by_language', true],
      ['deterministic_critic_unsupported_claims', true],
      ['first_progress_p95', true],
      ['raw_private_cloud_leaks', true],
      ['composer_mode_share', true],
    ]);
  });

  it('fails closed when a required language bucket has no samples', () => {
    const result = evaluateChatAnswerCanaryExit({
      acceptanceSamples: [
        ...acceptance('en', 10, 10),
        ...acceptance('pt-BR', 10, 10),
        ...acceptance('mixed', 10, 10),
      ],
      unsupportedClaimSamples: unsupportedClaims(20, 20),
      progressSamples: progress([500, 600, 700]),
      privacySamples: privacy([false]),
      compositionSamples: composition(20, 1),
    });

    const languageGate = result.gates.find((gate) => gate.gateId === 'answer_acceptance_by_language');
    expect(result.passed).toBe(false);
    expect(languageGate).toMatchObject({
      passed: false,
      reasonCode: 'missing_required_language_samples',
    });
    expect(result.languageResults.find((bucket) => bucket.language === 'pt-PT')).toMatchObject({
      total: 0,
      passed: false,
    });
  });

  it('fails the safety gates for weak critic coverage, slow progress, privacy leaks, and composer drift', () => {
    const result = evaluateChatAnswerCanaryExit({
      acceptanceSamples: [
        ...acceptance('en', 10, 10),
        ...acceptance('pt-BR', 10, 10),
        ...acceptance('pt-PT', 10, 10),
        ...acceptance('mixed', 10, 10),
      ],
      unsupportedClaimSamples: unsupportedClaims(20, 18),
      progressSamples: progress([500, 600, 2_500]),
      privacySamples: privacy([false, true]),
      compositionSamples: composition(10, 4),
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'deterministic_critic_unsupported_claims')).toMatchObject({
      passed: false,
      observed: 0.9,
      threshold: 0.95,
    });
    expect(gate(result, 'first_progress_p95')).toMatchObject({
      passed: false,
      observed: 2_500,
      threshold: 2_000,
    });
    expect(gate(result, 'raw_private_cloud_leaks')).toMatchObject({
      passed: false,
      observed: 1,
    });
    expect(gate(result, 'composer_mode_share')).toMatchObject({
      passed: false,
      observed: 0.4,
      threshold: 0.35,
    });
  });

  it('supports the current ChatV2 pt bucket through explicit threshold overrides', () => {
    const result = evaluateChatAnswerCanaryExit({
      acceptanceSamples: [
        ...acceptance('en', 10, 9),
        ...acceptance('pt', 10, 9),
        ...acceptance('mixed', 10, 8),
      ],
      unsupportedClaimSamples: unsupportedClaims(20, 20),
      progressSamples: progress([500, 700, 1_100]),
      privacySamples: privacy([false]),
      compositionSamples: composition(20, 2),
      thresholds: {
        requiredLanguages: ['en', 'pt', 'mixed'],
      },
    });

    expect(result.passed).toBe(true);
    expect(result.languageResults.map((bucket) => bucket.language)).toEqual(['en', 'pt', 'mixed']);
  });
});

function acceptance(
  language: ChatAnswerCanaryAcceptanceSample['language'],
  total: number,
  acceptedCount: number,
): ChatAnswerCanaryAcceptanceSample[] {
  return Array.from({ length: total }, (_, index) => ({
    sampleId: `${language}-${index}`,
    language,
    accepted: index < acceptedCount,
  }));
}

function unsupportedClaims(total: number, caughtCount: number): ChatAnswerCanaryUnsupportedClaimSample[] {
  return Array.from({ length: total }, (_, index) => ({
    sampleId: `unsupported-${index}`,
    caughtByDeterministicCritic: index < caughtCount,
  }));
}

function progress(values: number[]): ChatAnswerCanaryProgressSample[] {
  return values.map((firstProgressMs, index) => ({
    sampleId: `progress-${index}`,
    firstProgressMs,
  }));
}

function privacy(values: boolean[]): ChatAnswerCanaryPrivacySample[] {
  return values.map((leakedRawPrivateField, index) => ({
    sampleId: `privacy-${index}`,
    leakedRawPrivateField,
  }));
}

function composition(total: number, modelConstrainedCount: number): ChatAnswerCanaryCompositionSample[] {
  return Array.from({ length: total }, (_, index) => ({
    sampleId: `composition-${index}`,
    mode: index < modelConstrainedCount ? 'model_constrained' : 'templated',
  }));
}

function gate(
  result: ReturnType<typeof evaluateChatAnswerCanaryExit>,
  gateId: ReturnType<typeof evaluateChatAnswerCanaryExit>['gates'][number]['gateId'],
) {
  const found = result.gates.find((item) => item.gateId === gateId);
  expect(found).toBeDefined();
  return found!;
}
