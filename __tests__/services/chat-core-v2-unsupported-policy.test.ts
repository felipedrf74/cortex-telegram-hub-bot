import { describe, expect, it } from 'vitest';

import {
  CHAT_CORE_V2_UNSUPPORTED_POLICY_VERSION,
  CHAT_CORE_V2_UNSUPPORTED_REASONS,
  buildChatCoreV2RouteDecision,
  buildChatCoreV2UnsupportedResolution,
  getChatCoreV2UnsupportedPolicy,
  listChatCoreV2UnsupportedPolicies,
  type UnsupportedReason,
} from '../../src/services/chat-core-v2';

const ALL_UNSUPPORTED_REASONS: UnsupportedReason[] = [
  'not_built',
  'restricted_domain',
  'requires_external_auth',
  'unsafe_action',
  'ambiguous_scope',
  'too_large_batch',
  'manual_only',
];

describe('Chat Core v2 unsupported capability policy', () => {
  it('keeps every unsupported reason covered by executable policy metadata', () => {
    expect(CHAT_CORE_V2_UNSUPPORTED_REASONS).toEqual(ALL_UNSUPPORTED_REASONS);

    for (const policy of listChatCoreV2UnsupportedPolicies()) {
      expect(policy.policyVersion, policy.reason).toBe(CHAT_CORE_V2_UNSUPPORTED_POLICY_VERSION);
      expect(policy.blocksExecution, policy.reason).toBe(true);
      expect(policy.alternatives.en, policy.reason).toBeTruthy();
      expect(policy.alternatives['pt-PT'], policy.reason).toBeTruthy();
      expect(policy.alternatives['pt-BR'], policy.reason).toBeTruthy();
      expect(Object.keys(policy.alternatives).sort(), policy.reason).toEqual(['en', 'pt-BR', 'pt-PT']);
    }
  });

  it('blocks restricted domains without read fallback or action cards', () => {
    const resolution = buildChatCoreV2UnsupportedResolution({
      reason: 'restricted_domain',
      locale: 'en',
      domain: 'finance',
      capabilityId: 'finance.payment_or_tax_action_blocked',
    });

    expect(resolution).toMatchObject({
      policyVersion: CHAT_CORE_V2_UNSUPPORTED_POLICY_VERSION,
      reason: 'restricted_domain',
      routeMethod: 'blocked',
      responseKind: 'unsupported',
      severity: 'block',
      blocksExecution: true,
      allowReadFallback: false,
      domain: 'finance',
      capabilityId: 'finance.payment_or_tax_action_blocked',
    });
    expect(resolution.response.kind).toBe('unsupported');
    expect(resolution.response.cards).toEqual([]);
    expect(resolution.response.reasonCodes).toEqual(['restricted_domain']);
    expect(resolution.response.text).toContain('manual review');
  });

  it('turns ambiguous scope into a deterministic clarification instead of an unsupported dead-end', () => {
    const resolution = buildChatCoreV2UnsupportedResolution({
      reason: 'ambiguous_scope',
      locale: 'pt-BR',
      domain: 'tasks',
      question: 'Qual tarefa você quer alterar?',
      options: ['Ligar para Joao', 'Enviar fatura'],
    });

    expect(resolution.routeMethod).toBe('needs_clarification');
    expect(resolution.responseKind).toBe('clarification');
    expect(resolution.allowReadFallback).toBe(true);
    expect(resolution.response).toMatchObject({
      kind: 'clarification',
      locale: 'pt-BR',
      text: 'Qual tarefa você quer alterar?',
      reasonCodes: ['ambiguous_scope'],
    });
    expect(resolution.response.cards[0]).toMatchObject({
      type: 'clarification_card',
      options: ['Ligar para Joao', 'Enviar fatura'],
    });
    expect(resolution.response.cards[0].primaryAction).toBeUndefined();
  });

  it('localizes unsupported alternatives while preserving the same reason code contract', () => {
    const resolution = buildChatCoreV2UnsupportedResolution({
      reason: 'requires_external_auth',
      locale: 'pt-PT',
      domain: 'connections',
    });

    expect(resolution.supportedAlternative).toContain('Volta a ligar');
    expect(resolution.response.locale).toBe('pt-PT');
    expect(resolution.response.reasonCodes).toEqual(['requires_external_auth']);
  });

  it('returns defensive cloned policy objects so callers cannot mutate the registry', () => {
    const first = getChatCoreV2UnsupportedPolicy('too_large_batch');
    first.alternatives.en = 'mutated';

    expect(getChatCoreV2UnsupportedPolicy('too_large_batch').alternatives.en).not.toBe('mutated');
  });

  it('routes explicit ambiguous-scope decisions to clarification without spending model calls', () => {
    const decision = buildChatCoreV2RouteDecision({
      intent: 'modify_action',
      confidence: 0.93,
      domains: ['tasks'],
      capabilityIds: ['tasks.complete'],
      unsupportedReason: 'ambiguous_scope',
    });

    expect(decision).toMatchObject({
      routeMethod: 'needs_clarification',
      reasoningTier: 'none',
      requiresLLM: false,
      unsupportedReason: 'ambiguous_scope',
    });
    expect(decision.reasonCodes).toEqual(['unsupported_capability']);
  });
});
