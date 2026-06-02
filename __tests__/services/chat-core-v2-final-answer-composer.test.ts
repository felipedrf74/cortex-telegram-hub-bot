import { describe, expect, it } from 'vitest';

import {
  COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
  type ComposedAnswerDraft,
} from '../../src/services/chat-core-v2/answer-composition';
import {
  CHAT_CORE_V2_FINAL_ANSWER_COMPOSER_VERSION,
  composeChatCoreV2FinalAnswer,
} from '../../src/services/chat-core-v2/final-answer-composer';

function draft(overrides: Partial<ComposedAnswerDraft> = {}): ComposedAnswerDraft {
  return {
    schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
    mode: 'model_constrained',
    locale: 'pt-BR',
    text: 'Escolhe uma próxima ação pequena.',
    factualClaims: [],
    reasonCodes: ['test'],
    ...overrides,
  };
}

describe('ChatCoreV2 final answer composer', () => {
  it('turns a validated composed draft into the canonical ChatCoreV2 response contract', () => {
    const result = composeChatCoreV2FinalAnswer({
      draft: draft(),
      expectedLocale: 'pt-BR',
      extraReasonCodes: ['extra'],
    });

    expect(CHAT_CORE_V2_FINAL_ANSWER_COMPOSER_VERSION).toBe('chat_core_v2_final_answer_composer@1.0.0');
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.response).toEqual(expect.objectContaining({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'pt-BR',
      text: 'Escolhe uma próxima ação pequena.',
      cards: [],
      reasonCodes: ['test', 'extra'],
    }));
  });

  it('rejects supported factual claims that lack evidence before response construction', () => {
    const result = composeChatCoreV2FinalAnswer({
      draft: draft({
        factualClaims: [
          {
            claimId: 'claim-1',
            text: 'You have two tasks due today.',
            evidenceIds: [],
            support: 'supported',
          },
        ],
      }),
      expectedLocale: 'pt-BR',
    });

    expect(result.ok).toBe(false);
    expect(result.response).toBeUndefined();
    expect(result.issues).toContain('unsupported_factual_claim');
  });

  it('rejects drafts whose locale does not match the expected turn locale', () => {
    const result = composeChatCoreV2FinalAnswer({
      draft: draft({
        locale: 'en',
        text: 'Pick one small next action.',
      }),
      expectedLocale: 'pt-BR',
    });

    expect(result.ok).toBe(false);
    expect(result.response).toBeUndefined();
    expect(result.issues).toContain('composer_locale_mismatch');
  });
});
