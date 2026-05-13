// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { NexusAnswerContract, NexusChatActionability } from './chat-answer-contract';

export type ChatFallbackOperationKind =
  | 'read_only_answer'
  | 'explanation'
  | 'mutating_action'
  | 'provider_write'
  | 'model_failure'
  | 'tool_failure'
  | 'cross_skill_conflict';

export interface ChatFallbackPolicyDecision {
  operationKind: ChatFallbackOperationKind;
  fallbackAllowed: boolean;
  mayUseCachedData: boolean;
  requiresFreshnessLabel: boolean;
  mayClaimSuccess: boolean;
  retryable: boolean;
  userActionRequired: boolean;
  operatorActionRequired: boolean;
  responseMode: 'answer' | 'clarify' | 'degraded' | 'partial_failure' | 'blocked' | 'decision_center';
  reason: string;
}

export interface ChatFallbackPolicyResult {
  policy: ChatFallbackPolicyDecision;
  contract: NexusAnswerContract;
  issues: string[];
}

export function classifyChatFallbackOperation(contract: NexusAnswerContract): ChatFallbackOperationKind {
  if (contract.actionability === 'decision_center') return 'cross_skill_conflict';
  if (contract.actionability === 'execute' || contract.actionability === 'preview') {
    if (contract.verificationStatus === 'partial_failure') return 'provider_write';
    return 'mutating_action';
  }
  if (contract.fallback.fallbackType === 'tool_failure') return 'tool_failure';
  if (contract.fallback.fallbackType === 'model_unavailable' || contract.fallback.fallbackType === 'provider_fallback') {
    return 'model_failure';
  }
  if (contract.intent.endsWith('.explain')) return 'explanation';
  return 'read_only_answer';
}

export function resolveChatFallbackPolicy(contract: NexusAnswerContract): ChatFallbackPolicyDecision {
  const operationKind = classifyChatFallbackOperation(contract);
  switch (operationKind) {
    case 'read_only_answer':
      return {
        operationKind,
        fallbackAllowed: true,
        mayUseCachedData: true,
        requiresFreshnessLabel: contract.fallbackUsed || contract.staleness !== 'fresh',
        mayClaimSuccess: false,
        retryable: contract.fallback.retryable,
        userActionRequired: false,
        operatorActionRequired: contract.fallback.operatorActionRequired,
        responseMode: contract.missingFacts.length > 0 ? 'clarify' : 'answer',
        reason: 'Read-only answers may use cached or degraded facts when freshness is visible.',
      };
    case 'explanation':
      return {
        operationKind,
        fallbackAllowed: true,
        mayUseCachedData: true,
        requiresFreshnessLabel: contract.fallbackUsed || contract.staleness !== 'fresh',
        mayClaimSuccess: false,
        retryable: contract.fallback.retryable,
        userActionRequired: contract.missingFacts.length > 0,
        operatorActionRequired: contract.fallback.operatorActionRequired,
        responseMode: contract.missingFacts.length > 0 ? 'clarify' : 'answer',
        reason: 'Explanations may fall back to deterministic summaries but cannot invent state.',
      };
    case 'mutating_action':
      return {
        operationKind,
        fallbackAllowed: false,
        mayUseCachedData: false,
        requiresFreshnessLabel: true,
        mayClaimSuccess: contract.verificationStatus === 'verified',
        retryable: contract.fallback.retryable,
        userActionRequired: true,
        operatorActionRequired: contract.fallback.operatorActionRequired,
        responseMode: contract.verificationStatus === 'verified' ? 'answer' : 'blocked',
        reason: 'Mutating actions cannot use fallback as proof of success; read-back verification is required.',
      };
    case 'provider_write':
      return {
        operationKind,
        fallbackAllowed: true,
        mayUseCachedData: false,
        requiresFreshnessLabel: true,
        mayClaimSuccess: false,
        retryable: contract.fallback.retryable,
        userActionRequired: contract.fallback.userActionRequired,
        operatorActionRequired: contract.fallback.operatorActionRequired,
        responseMode: 'partial_failure',
        reason: 'Provider writes must report partial failure when Nexus changed internal state but external verification failed.',
      };
    case 'model_failure':
      return {
        operationKind,
        fallbackAllowed: true,
        mayUseCachedData: contract.actionability === 'answer_only',
        requiresFreshnessLabel: true,
        mayClaimSuccess: false,
        retryable: contract.fallback.retryable,
        userActionRequired: contract.fallback.userActionRequired,
        operatorActionRequired: contract.fallback.operatorActionRequired,
        responseMode: contract.actionability === 'answer_only' ? 'degraded' : 'clarify',
        reason: 'Model failure may degrade to deterministic grounded output, never to model-only action success.',
      };
    case 'tool_failure':
      return {
        operationKind,
        fallbackAllowed: true,
        mayUseCachedData: false,
        requiresFreshnessLabel: true,
        mayClaimSuccess: false,
        retryable: contract.fallback.retryable,
        userActionRequired: contract.fallback.userActionRequired,
        operatorActionRequired: contract.fallback.operatorActionRequired,
        responseMode: 'degraded',
        reason: 'Tool failures must be classified as degraded provider/tool state with retryability.',
      };
    case 'cross_skill_conflict':
      return {
        operationKind,
        fallbackAllowed: false,
        mayUseCachedData: false,
        requiresFreshnessLabel: true,
        mayClaimSuccess: false,
        retryable: false,
        userActionRequired: true,
        operatorActionRequired: false,
        responseMode: 'decision_center',
        reason: 'Cross-skill conflicts should route to Decision Center instead of guessing.',
      };
  }
}

export function applyChatFallbackPolicy(contract: NexusAnswerContract): ChatFallbackPolicyResult {
  const policy = resolveChatFallbackPolicy(contract);
  const issues: string[] = [];
  let nextContract = contract;

  if (contract.fallbackUsed && !policy.fallbackAllowed) {
    issues.push('fallback_not_allowed_for_operation');
  }
  if (contract.fallbackUsed && !policy.mayClaimSuccess && contract.actionability === 'execute' && contract.verificationStatus !== 'verified') {
    issues.push('success_requires_verifier');
  }

  if (issues.length > 0) {
    const actionability: NexusChatActionability = policy.responseMode === 'decision_center'
      ? 'decision_center'
      : policy.responseMode === 'blocked'
        ? 'blocked'
        : 'degraded';
    nextContract = {
      ...contract,
      actionability,
      verificationStatus: contract.verificationStatus === 'verified' ? 'verified' : 'blocked',
      missingFacts: [...new Set([
        ...contract.missingFacts,
        ...(policy.mayClaimSuccess ? [] : ['verified_mutation_result']),
      ])],
      fallback: {
        ...contract.fallback,
        userActionRequired: true,
      },
    };
  }

  return { policy, contract: nextContract, issues };
}
