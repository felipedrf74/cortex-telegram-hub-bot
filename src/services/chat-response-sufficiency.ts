// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatContextItem, ChatWeakContextSignal } from './chat-context-engine';

export type ChatActionStatus =
  | 'none'
  | 'needs_confirmation'
  | 'needs_clarification'
  | 'succeeded'
  | 'failed'
  | 'blocked';

export interface ChatResponseSufficiencyMetadata {
  actionStatus: ChatActionStatus;
  responseSufficient: boolean;
  requiresConfirmation: boolean;
  needsClarification: boolean;
  unresolvedBlockers: string[];
  contextSources: Array<{
    source: ChatContextItem['source'];
    freshness: ChatContextItem['freshness'];
    confidence: number;
    reason: string;
  }>;
  weakContextSignals: string[];
}

export interface BuildChatResponseSufficiencyInput {
  actionStatus?: ChatActionStatus;
  requiresConfirmation?: boolean;
  needsClarification?: boolean;
  unresolvedBlockers?: string[];
  contextItems?: Pick<ChatContextItem, 'source' | 'freshness' | 'confidence' | 'reason'>[];
  weakSignals?: Pick<ChatWeakContextSignal, 'code'>[];
}

export function buildChatResponseSufficiencyMetadata(
  input: BuildChatResponseSufficiencyInput = {},
): ChatResponseSufficiencyMetadata {
  const weakContextSignals = [...new Set((input.weakSignals ?? []).map((signal) => signal.code))];
  const blockers = new Set(input.unresolvedBlockers ?? []);
  if (input.requiresConfirmation) blockers.add('explicit_confirmation_required');
  if (input.needsClarification) blockers.add('targeted_clarification_required');
  for (const signal of weakContextSignals) {
    if (signal === 'ambiguous_follow_up_without_history' || signal === 'unsafe_ambiguous_action') {
      blockers.add('ambiguous_reference');
    }
    if (signal === 'memory_recall_without_memory') blockers.add('missing_memory_context');
    if (signal === 'low_confidence_context') blockers.add('low_confidence_context');
    if (signal === 'tenant_boundary_requires_confirmation') blockers.add('tenant_boundary_requires_confirmation');
  }

  const actionStatus = input.actionStatus
    ?? (input.requiresConfirmation ? 'needs_confirmation' : input.needsClarification ? 'needs_clarification' : 'none');

  const unresolvedBlockers = [...blockers];
  return {
    actionStatus,
    responseSufficient: unresolvedBlockers.length === 0 && actionStatus !== 'failed' && actionStatus !== 'blocked',
    requiresConfirmation: Boolean(input.requiresConfirmation),
    needsClarification: Boolean(input.needsClarification),
    unresolvedBlockers,
    contextSources: (input.contextItems ?? []).map((item) => ({
      source: item.source,
      freshness: item.freshness,
      confidence: item.confidence,
      reason: item.reason,
    })),
    weakContextSignals,
  };
}
