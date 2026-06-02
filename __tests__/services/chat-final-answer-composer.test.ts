import { describe, expect, it } from 'vitest';

import { buildNexusAnswerContract } from '../../src/services/chat-answer-contract';
import {
  buildNexusComposedAnswerDraft,
  composeNexusFinalAnswer,
  NEXUS_FINAL_ANSWER_COMPOSER_VERSION,
  validateNexusComposedAnswerDraft,
  type NexusComposedAnswerDraft,
} from '../../src/services/chat-final-answer-composer';

function baseContract() {
  return buildNexusAnswerContract({
    intent: 'chat.answer',
    ownerSkill: 'chat',
    routeMethod: 'local-model',
    actionability: 'answer_only',
    verificationStatus: 'not_required',
    language: 'pt',
    confidence: 0.9,
  });
}

describe('chat final answer composer', () => {
  it('turns safe draft text into the canonical gated final answer', () => {
    const contract = baseContract();
    const draft = buildNexusComposedAnswerDraft({
      text: 'Define uma meta pequena e revê o progresso no fim do dia.',
      contract,
      mode: 'model_constrained',
    });

    const result = composeNexusFinalAnswer({ draft, contract });

    expect(result.composerVersion).toBe(NEXUS_FINAL_ANSWER_COMPOSER_VERSION);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Define uma meta pequena');
    expect(result.contract.language).toBe('pt');
    expect(result.issues).toEqual([]);
  });

  it('rejects supported factual claims without evidence before final answer trust', () => {
    const contract = baseContract();
    const draft = buildNexusComposedAnswerDraft({
      text: 'Tens duas tarefas para hoje.',
      contract,
      factualClaims: [{
        claimId: 'claim-1',
        text: 'Tens duas tarefas para hoje.',
        evidenceIds: [],
        support: 'supported',
      }],
    });

    expect(validateNexusComposedAnswerDraft(draft, contract)).toContain('unsupported_factual_claim');

    const result = composeNexusFinalAnswer({ draft, contract });
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('unsupported_factual_claim');
  });

  it('flags composer language mismatch', () => {
    const contract = baseContract();
    const draft: NexusComposedAnswerDraft = {
      ...buildNexusComposedAnswerDraft({ text: 'Pick one small step.', contract }),
      language: 'en',
    };

    const result = composeNexusFinalAnswer({ draft, contract });

    expect(result.ok).toBe(false);
    expect(result.issues).toContain('composer_language_mismatch');
  });

  it('rewrites unverified model action claims through the quality gate', () => {
    const contract = baseContract();
    const draft = buildNexusComposedAnswerDraft({
      text: 'Guardei a receita.',
      contract,
    });

    const result = composeNexusFinalAnswer({ draft, contract });

    expect(result.ok).toBe(false);
    expect(result.issues).toContain('unverified_success_claim');
    expect(result.text).toContain('não posso afirmar que a ação foi concluída');
    expect(result.text).not.toContain('Guardei a receita');
  });

  it('always repairs unverified action claims even when optional quality gate is disabled', () => {
    const contract = baseContract();
    const draft = buildNexusComposedAnswerDraft({
      text: 'Adicionei isso à tua lista.',
      contract,
    });

    const result = composeNexusFinalAnswer({
      draft,
      contract,
      qualityGateEnabled: false,
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContain('unverified_success_claim');
    expect(result.text).toContain('não posso afirmar que a ação foi concluída');
    expect(result.text).not.toContain('Adicionei isso');
  });
});
