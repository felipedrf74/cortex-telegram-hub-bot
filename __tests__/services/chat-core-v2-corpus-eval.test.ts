import { describe, expect, it } from 'vitest';

import { validateGoldenCorpus } from '../../src/services/chat-core-v2/golden-corpus';
import { CHAT_CORE_V2_SYNTHETIC_CORPUS } from '../../src/services/chat-core-v2/golden-corpus-synthetic';
import {
  evaluateCorpusItem,
  summarizeCorpusEval,
  type RuntimeChatResponse,
} from '../../src/services/chat-core-v2/corpus-eval';
import type { ChatCoreV2GoldenCorpusItem } from '../../src/services/chat-core-v2/golden-corpus';

describe('ChatCoreV2 synthetic corpus', () => {
  it('is well-formed across all languages and every item is fully labeled', () => {
    // min=1 so the 200-item gate does not fire; we are validating shape here.
    const issues = validateGoldenCorpus(CHAT_CORE_V2_SYNTHETIC_CORPUS, 1);
    // It is well-formed (no schema/language/capability/evidence gaps)...
    expect(issues).not.toContain('invalid_schema_version');
    expect(issues).not.toContain('missing_language');
    expect(issues).not.toContain('missing_expected_capability');
    expect(issues).not.toContain('missing_evidence_requirement');
    // ...but is honestly flagged synthetic-only, proving it does NOT by itself
    // clear the Phase 2 gate (real labels still required).
    expect(issues).toEqual(['synthetic_only']);
  });

  it('covers all four corpus languages', () => {
    const langs = new Set(CHAT_CORE_V2_SYNTHETIC_CORPUS.items.map((item) => item.language));
    expect(langs).toEqual(new Set(['en', 'pt-BR', 'pt-PT', 'mixed']));
  });
});

const baseItem: ChatCoreV2GoldenCorpusItem = {
  id: 'x-1',
  source: 'manual_regression',
  language: 'en',
  message: 'm',
  expectedDomainIds: ['cooking'],
  expectedCapabilityIds: ['cooking.recipe_answer'],
  expectedIntent: 'answer',
  forbiddenClaims: ['no claim'],
  evidenceRequirements: ['model_constrained'],
};

describe('ChatCoreV2 corpus eval logic', () => {
  it('passes an answer routed via the local-LLM path with no success claim', () => {
    const response: RuntimeChatResponse = {
      text: 'Here is a salmon recipe with ingredients and method.',
      routeMethod: 'chat-core-v2-local-llm',
      verificationStatus: 'not_required',
    };
    const result = evaluateCorpusItem(baseItem, response);
    expect(result.pass).toBe(true);
  });

  it('flags an unverified first-person success claim on an answer', () => {
    const response: RuntimeChatResponse = {
      text: 'Done — I created the task for you.',
      routeMethod: 'chat-core-v2-local-llm',
      verificationStatus: 'not_required',
    };
    const result = evaluateCorpusItem(baseItem, response);
    expect(result.pass).toBe(false);
    expect(result.failedChecks).toContain('unverified_success_claim');
  });

  it('flags fabricated cancellation / intent-to-act claims', () => {
    const item = { ...baseItem, expectedIntent: 'clarify' as const };
    for (const text of ['Okay, cancelado.', 'Entendi, vou cancelar isso.', "I'll cancel that for you."]) {
      const result = evaluateCorpusItem(item, { text, routeMethod: 'chat-core-v2-local-llm' });
      expect(result.failedChecks).toContain('unverified_success_claim');
    }
  });

  it('accepts a success message when the runtime marks it verified', () => {
    const item = { ...baseItem, expectedIntent: 'write_preview' as const };
    const response: RuntimeChatResponse = {
      text: 'Done — I marked "buy supplements" as done.',
      routeMethod: 'chat-core-v2-command-confirmation',
      verificationStatus: 'verified',
    };
    expect(evaluateCorpusItem(item, response).pass).toBe(true);
  });

  it('flags a route/intent mismatch (read answered by a write route)', () => {
    const item = { ...baseItem, expectedIntent: 'read' as const };
    const response: RuntimeChatResponse = { text: 'tasks', routeMethod: 'chat-core-v2-command-confirmation' };
    const result = evaluateCorpusItem(item, response);
    expect(result.failedChecks).toContain('route_intent_mismatch');
  });

  it('flags a pt-BR request answered in English (locale not preserved)', () => {
    const item = { ...baseItem, language: 'pt-BR' as const };
    const response: RuntimeChatResponse = { text: 'Here is your recipe.', routeMethod: 'chat-core-v2-local-llm' };
    expect(evaluateCorpusItem(item, response).failedChecks).toContain('locale_not_preserved');
  });

  it('summarizes pass rate by language', () => {
    const results = [
      evaluateCorpusItem(baseItem, { text: 'ok', routeMethod: 'chat-core-v2-local-llm' }),
      evaluateCorpusItem({ ...baseItem, language: 'pt-BR' }, { text: 'aqui está a receita', routeMethod: 'chat-core-v2-local-llm' }),
    ];
    const summary = summarizeCorpusEval(results);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);
    expect(summary.byLanguage['pt-BR']).toEqual({ total: 1, passed: 1 });
  });
});
