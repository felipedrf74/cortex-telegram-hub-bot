// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2RouteMethod, FallbackReason } from './types';

export interface FallbackPolicyInput {
  reason: FallbackReason;
  routeMethod: ChatCoreV2RouteMethod;
  hasWriteIntent: boolean;
  oldPathHasEquivalentSafety?: boolean;
}

export interface FallbackPolicyVerdict {
  allowed: boolean;
  reason: FallbackReason;
  blockedBecause?: 'write_without_equivalent_safety' | 'blocked_route' | 'unsupported_reason';
}

const READ_FALLBACK_REASONS = new Set<FallbackReason>([
  'v2_unsupported',
  'v2_schema_failure',
  'v2_context_failure',
  'v2_llm_failure',
  'v2_execution_disabled',
  'v2_timeout',
  'tenant_flag_disabled',
]);

export function evaluateChatCoreV2Fallback(input: FallbackPolicyInput): FallbackPolicyVerdict {
  if (input.routeMethod === 'blocked') {
    return { allowed: false, reason: input.reason, blockedBecause: 'blocked_route' };
  }

  if (!READ_FALLBACK_REASONS.has(input.reason)) {
    return { allowed: false, reason: input.reason, blockedBecause: 'unsupported_reason' };
  }

  if (input.hasWriteIntent && !input.oldPathHasEquivalentSafety) {
    return {
      allowed: false,
      reason: input.reason,
      blockedBecause: 'write_without_equivalent_safety',
    };
  }

  return { allowed: true, reason: input.reason };
}
