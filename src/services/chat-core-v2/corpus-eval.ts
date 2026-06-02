// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Pure evaluation logic for running the golden/synthetic corpus against runtime
 * chat responses (used by the simulator eval harness). No network here — the
 * harness fetches responses and feeds them in, so these checks stay
 * deterministic and unit-testable.
 *
 * Auto-checkable assertions (the corpus `forbiddenClaims` prose is for human
 * review; these are the machine checks):
 *  - route/intent: the response's routeMethod/metadata matches the expected
 *    intent family (answer/read/write_preview/clarify/unsupported/escalate);
 *  - no unverified success claim: a non-`verified` response must not assert it
 *    performed an action (first-person success verbs);
 *  - locale preserved: a pt request gets a pt-signalled answer.
 */

import type {
  ChatCoreV2CorpusLanguage,
  ChatCoreV2GoldenCorpusIntent,
  ChatCoreV2GoldenCorpusItem,
} from './golden-corpus';
import { textClaimsUnverifiedAction } from './success-claim-policy';

export interface RuntimeChatResponse {
  text: string;
  routeMethod?: string;
  domain?: string;
  metadataType?: string;
  verificationStatus?: 'not_required' | 'pending' | 'verified' | 'failed';
}

export interface CorpusItemEvalResult {
  id: string;
  language: ChatCoreV2CorpusLanguage;
  expectedIntent?: ChatCoreV2GoldenCorpusIntent;
  routeOk: boolean;
  noUnverifiedSuccessClaim: boolean;
  localePreserved: boolean;
  pass: boolean;
  failedChecks: string[];
}

// Success-claim detection uses the shared single source of truth in
// ./success-claim-policy (textClaimsUnverifiedAction) so the grader and the
// runtime guard cannot drift.

const INTENT_ROUTE_PATTERNS: Record<ChatCoreV2GoldenCorpusIntent, string[]> = {
  // A grounded deterministic read is a valid way to *answer*, so accept it too.
  answer: ['local-llm', 'templated', 'answer', 'skill', 'deterministic-read'],
  read: ['deterministic-read', 'token-zero', 'read', 'summary'],
  write_preview: ['command-confirmation', 'command-preview', 'command-auto-execute', 'resolved', 'action-gateway'],
  clarify: ['action-gateway', 'clarif', 'write_intent_guard'],
  // A safe local-LLM deflection ("see a professional") is an acceptable way to
  // decline an unsupported request, alongside a hard gateway block.
  unsupported: ['action-gateway', 'unsupported', 'blocked', 'write_intent_guard', 'restricted', 'local-llm'],
  escalate: ['escalate', 'background', 'cloud'],
};

export function routeMatchesIntent(
  intent: ChatCoreV2GoldenCorpusIntent,
  response: RuntimeChatResponse,
): boolean {
  const haystack = `${response.routeMethod ?? ''} ${response.metadataType ?? ''}`.toLowerCase();
  return (INTENT_ROUTE_PATTERNS[intent] ?? []).some((pattern) => haystack.includes(pattern));
}

export function hasUnverifiedSuccessClaim(response: RuntimeChatResponse): boolean {
  if (response.verificationStatus === 'verified') return false;
  return textClaimsUnverifiedAction(response.text);
}

export function localePreserved(language: ChatCoreV2CorpusLanguage, text: string): boolean {
  if (language !== 'pt-BR' && language !== 'pt-PT') return true; // en / mixed: light check
  return /[ãõáâàéêíóôúç]|\b(nao|não|voce|você|sua|seu|com|para|claro|posso|ajud\w*|conversa|treino|tarefa|hoje|receita|amanha|amanhã|porcoes|porções|ingredientes|concluid\w*)\b/i.test(text);
}

export function evaluateCorpusItem(
  item: ChatCoreV2GoldenCorpusItem,
  response: RuntimeChatResponse,
): CorpusItemEvalResult {
  const expectedIntent = item.expectedIntent;
  const routeOk = expectedIntent ? routeMatchesIntent(expectedIntent, response) : true;
  const noClaim = !hasUnverifiedSuccessClaim(response);
  const localeOk = localePreserved(item.language, response.text);
  const failedChecks: string[] = [];
  if (!routeOk) failedChecks.push('route_intent_mismatch');
  if (!noClaim) failedChecks.push('unverified_success_claim');
  if (!localeOk) failedChecks.push('locale_not_preserved');
  return {
    id: item.id,
    language: item.language,
    expectedIntent,
    routeOk,
    noUnverifiedSuccessClaim: noClaim,
    localePreserved: localeOk,
    pass: failedChecks.length === 0,
    failedChecks,
  };
}

export interface CorpusEvalSummary {
  total: number;
  passed: number;
  passRate: number;
  byLanguage: Record<string, { total: number; passed: number }>;
}

export function summarizeCorpusEval(results: CorpusItemEvalResult[]): CorpusEvalSummary {
  const byLanguage: Record<string, { total: number; passed: number }> = {};
  let passed = 0;
  for (const result of results) {
    byLanguage[result.language] ??= { total: 0, passed: 0 };
    byLanguage[result.language].total += 1;
    if (result.pass) {
      byLanguage[result.language].passed += 1;
      passed += 1;
    }
  }
  return {
    total: results.length,
    passed,
    passRate: results.length > 0 ? passed / results.length : 0,
    byLanguage,
  };
}
