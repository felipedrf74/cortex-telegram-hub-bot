// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  buildChatShadowSampleEvidenceHash,
  countUnsafeChatShadowRawFields,
  evaluateChatShadowGateReadiness,
  type ChatShadowGateSample,
  type NexusChatShadowLanguage,
} from '../../src/services/chat-shadow-gate-readiness';

describe('evaluateChatShadowGateReadiness', () => {
  it('passes when Phase 2 shadow gates meet the Work Order thresholds', () => {
    const result = evaluateChatShadowGateReadiness({
      samples: [
        ...shadowSamples('en', 15, 15),
        ...shadowSamples('pt-BR', 15, 15),
        ...shadowSamples('pt-PT', 10, 10),
        ...shadowSamples('mixed', 10, 9),
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.gates.map((gate) => [gate.gateId, gate.passed])).toEqual([
      ['shadow_row_floor', true],
      ['schema_validity_after_repair', true],
      ['recall_at_k_by_language', true],
      ['shadow_storage_privacy', true],
      ['shadow_candidate_evidence_binding', true],
    ]);
  });

  it('fails closed below the minimum shadow row floor', () => {
    const result = evaluateChatShadowGateReadiness({
      samples: [
        ...shadowSamples('en', 10, 10),
        ...shadowSamples('pt-BR', 10, 10),
        ...shadowSamples('pt-PT', 10, 10),
        ...shadowSamples('mixed', 10, 10),
      ],
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'shadow_row_floor')).toMatchObject({
      passed: false,
      observed: 40,
      threshold: 50,
      reasonCode: 'insufficient_shadow_rows',
    });
  });

  it('fails schema validity when bounded repair still leaves invalid plans', () => {
    const samples = [
      ...shadowSamples('en', 15, 15),
      ...shadowSamples('pt-BR', 15, 15),
      ...shadowSamples('pt-PT', 10, 10),
      ...shadowSamples('mixed', 10, 10),
    ];
    samples[0] = { ...samples[0], schemaValidAfterRepair: false };

    const result = evaluateChatShadowGateReadiness({ samples });

    expect(result.passed).toBe(false);
    expect(gate(result, 'schema_validity_after_repair')).toMatchObject({
      passed: false,
      observed: 0.98,
      threshold: 0.99,
    });
  });

  it('fails recall@8 when a required language misses its target or has no samples', () => {
    const result = evaluateChatShadowGateReadiness({
      samples: [
        ...shadowSamples('en', 20, 20),
        ...shadowSamples('pt-BR', 20, 20),
        ...shadowSamples('mixed', 10, 10),
      ],
    });

    expect(result.passed).toBe(false);
    expect(gate(result, 'recall_at_k_by_language')).toMatchObject({
      passed: false,
      reasonCode: 'missing_required_language_samples',
    });
    expect(result.languageResults.find((item) => item.language === 'pt-PT')).toMatchObject({
      total: 0,
      rate: 0,
      passed: false,
    });
  });

  it('counts only the top K candidate capabilities for recall', () => {
    const samples = [
      ...shadowSamples('en', 15, 15),
      ...shadowSamples('pt-BR', 15, 15),
      ...shadowSamples('pt-PT', 10, 10),
      ...shadowSamples('mixed', 10, 10),
    ];
    samples[0] = {
      ...samples[0],
      candidateCapabilities: [
        'candidate.0',
        'candidate.1',
        'candidate.2',
        'candidate.3',
        'candidate.4',
        'candidate.5',
        'candidate.6',
        'candidate.7',
        samples[0].finalCapabilityId!,
      ],
    };

    const result = evaluateChatShadowGateReadiness({ samples });

    expect(result.passed).toBe(false);
    expect(result.languageResults.find((item) => item.language === 'en')).toMatchObject({
      recalled: 14,
      total: 15,
      passed: false,
    });
  });

  it('fails if shadow storage keeps raw message text or non-HMAC identifiers', () => {
    const samples = [
      ...shadowSamples('en', 15, 15),
      ...shadowSamples('pt-BR', 15, 15),
      ...shadowSamples('pt-PT', 10, 10),
      ...shadowSamples('mixed', 10, 10),
    ];
    samples[0] = { ...samples[0], storedRawMessageText: true };
    samples[1] = { ...samples[1], messageIdentifierKind: 'raw' };

    const result = evaluateChatShadowGateReadiness({ samples });

    expect(result.passed).toBe(false);
    expect(gate(result, 'shadow_storage_privacy')).toMatchObject({
      passed: false,
      observed: 2,
      threshold: 0,
    });
  });

  it('fails if shadow storage keeps raw text under any audited metadata field', () => {
    const samples = [
      ...shadowSamples('en', 15, 15),
      ...shadowSamples('pt-BR', 15, 15),
      ...shadowSamples('pt-PT', 10, 10),
      ...shadowSamples('mixed', 10, 10),
    ];
    samples[0] = bindEvidenceHash({ ...samples[0], unsafeRawFieldCount: 1 });

    const result = evaluateChatShadowGateReadiness({ samples });

    expect(result.passed).toBe(false);
    expect(gate(result, 'shadow_storage_privacy')).toMatchObject({
      passed: false,
      observed: 1,
    });
  });

  it('audits nested shadow metadata for raw prompts/messages without flagging HMAC IDs', () => {
    expect(countUnsafeChatShadowRawFields({
      contextPack: {
        messageHash: 'hmac:message:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        messageIdentifierKind: 'hmac',
        rawMessage: 'crie uma tarefa com dados privados',
      },
      response: {
        selectedCapabilityId: 'tasks.create',
        prompt: 'private prompt text',
      },
    })).toBe(2);
  });

  it('binds the readiness evidence hash to the evaluated candidate capabilities', () => {
    const sample = shadowSamples('en', 1, 1)[0];
    const sameButDifferentCandidates: ChatShadowGateSample = {
      ...sample,
      candidateCapabilities: ['other.capability'],
    };

    expect(buildChatShadowSampleEvidenceHash(sample)).not.toBe(
      buildChatShadowSampleEvidenceHash(sameButDifferentCandidates),
    );
  });

  it('fails if the stored evidence hash does not match the evaluated candidates', () => {
    const samples = [
      ...shadowSamples('en', 15, 15),
      ...shadowSamples('pt-BR', 15, 15),
      ...shadowSamples('pt-PT', 10, 10),
      ...shadowSamples('mixed', 10, 10),
    ];
    samples[0] = { ...samples[0], candidateEvidenceHash: 'stale-hash-from-different-candidates' };

    const result = evaluateChatShadowGateReadiness({ samples });

    expect(result.passed).toBe(false);
    expect(gate(result, 'shadow_candidate_evidence_binding')).toMatchObject({
      passed: false,
      observed: 1,
      threshold: 0,
    });
  });

  it('supports the current ChatV2 pt bucket through explicit threshold overrides', () => {
    const result = evaluateChatShadowGateReadiness({
      samples: [
        ...shadowSamples('en', 20, 20),
        ...shadowSamples('pt', 20, 20),
        ...shadowSamples('mixed', 10, 10),
      ],
      thresholds: {
        requiredLanguages: ['en', 'pt', 'mixed'],
      },
    });

    expect(result.passed).toBe(true);
    expect(result.languageResults.map((item) => item.language)).toEqual(['en', 'pt', 'mixed']);
  });
});

function shadowSamples(
  language: NexusChatShadowLanguage,
  total: number,
  recalledCount: number,
): ChatShadowGateSample[] {
  return Array.from({ length: total }, (_, index) => {
    const finalCapabilityId = `${language}.capability.${index}`;
    return bindEvidenceHash({
      sampleId: `${language}-${index}`,
      language,
      finalCapabilityId,
      candidateCapabilities: index < recalledCount
        ? [finalCapabilityId]
        : [`${language}.other.${index}`],
      schemaValidAfterRepair: true,
      messageIdentifierKind: 'hmac',
      storedRawMessageText: false,
    });
  });
}

function bindEvidenceHash(sample: Omit<ChatShadowGateSample, 'candidateEvidenceHash'>): ChatShadowGateSample {
  const withHash: ChatShadowGateSample = { ...sample };
  return {
    ...withHash,
    candidateEvidenceHash: buildChatShadowSampleEvidenceHash(withHash),
  };
}

function gate(
  result: ReturnType<typeof evaluateChatShadowGateReadiness>,
  gateId: ReturnType<typeof evaluateChatShadowGateReadiness>['gates'][number]['gateId'],
) {
  const found = result.gates.find((item) => item.gateId === gateId);
  expect(found).toBeDefined();
  return found!;
}
