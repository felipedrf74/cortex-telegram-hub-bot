// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2Domain } from './types';

export const CHAT_CORE_V2_PREPASS_VERSION = 'chat_core_v2_prepass@0.1.0';
export const CHAT_CORE_V2_PREPASS_MIN_CANDIDATES = 3;
export const CHAT_CORE_V2_PREPASS_MAX_CANDIDATES = 8;

export interface ChatCoreV2ReferenceCandidate {
  entityType: string;
  entityId: string;
  confidence: number;
  reason: string;
}

export interface ChatCoreV2PrepassOutput {
  prepassVersion: typeof CHAT_CORE_V2_PREPASS_VERSION;
  candidateCapabilityIds: string[];
  activeDomainHint?: ChatCoreV2Domain;
  highRiskSignals: string[];
  referenceCandidates: ChatCoreV2ReferenceCandidate[];
  contextHash: string;
}

export type ChatCoreV2PrepassIssue =
  | 'too_few_candidates'
  | 'too_many_candidates'
  | 'missing_context_hash';

export type ChatCoreV2PrepassDeterminismIssue =
  | 'llm_provider_reference'
  | 'network_call'
  | 'model_call'
  | 'raw_cloud_fallback_reference';

export interface ChatCoreV2PrepassForbiddenSourcePattern {
  issue: ChatCoreV2PrepassDeterminismIssue;
  pattern: RegExp;
}

export const CHAT_CORE_V2_PREPASS_FORBIDDEN_SOURCE_PATTERNS: ChatCoreV2PrepassForbiddenSourcePattern[] = [
  {
    issue: 'llm_provider_reference',
    pattern: /\b(?:ollama|openai|anthropic|gemini|provider-fallback|provider-registry|ai-provider)\b/i,
  },
  {
    issue: 'network_call',
    pattern: /\b(?:fetch|axios|request)\s*\(/i,
  },
  {
    issue: 'model_call',
    pattern: /\b(?:callDomain|classifyWithClaude|getActiveProvider|getProvider|ollamaChat)\s*\(/i,
  },
  {
    issue: 'raw_cloud_fallback_reference',
    pattern: /\b(?:cloudFallback|cloudReasoning|cloud\s+fallback)\b/i,
  },
];

export function validatePrepassOutputBounds(output: ChatCoreV2PrepassOutput): ChatCoreV2PrepassIssue[] {
  const issues: ChatCoreV2PrepassIssue[] = [];
  if (output.candidateCapabilityIds.length < CHAT_CORE_V2_PREPASS_MIN_CANDIDATES) {
    issues.push('too_few_candidates');
  }
  if (output.candidateCapabilityIds.length > CHAT_CORE_V2_PREPASS_MAX_CANDIDATES) {
    issues.push('too_many_candidates');
  }
  if (output.contextHash.trim() === '') {
    issues.push('missing_context_hash');
  }
  return issues;
}

export function auditPrepassSourceForDeterminism(sourceText: string): ChatCoreV2PrepassDeterminismIssue[] {
  const issues = new Set<ChatCoreV2PrepassDeterminismIssue>();
  for (const rule of CHAT_CORE_V2_PREPASS_FORBIDDEN_SOURCE_PATTERNS) {
    if (rule.pattern.test(sourceText)) issues.add(rule.issue);
  }
  return [...issues];
}
