import { describe, expect, it } from 'vitest';

import {
  CHAT_CORE_V2_REASONING_POLICIES,
  addRuntimeBudgetUsage,
  canStartModelCall,
  canStartToolCall,
  checkRuntimeBudget,
  evaluateChatCoreV2Fallback,
  makeRuntimeBudgetUsage,
  resolveProviderDataPolicy,
} from '../../src/services/chat-core-v2';

describe('Chat Core v2 runtime guardrails', () => {
  it('blocks model calls before deterministic reads can spend tokens', () => {
    const usage = makeRuntimeBudgetUsage();
    const verdict = canStartModelCall(CHAT_CORE_V2_REASONING_POLICIES.none, usage);

    expect(verdict).toEqual({
      ok: false,
      limit: 'model_calls',
      used: 1,
      max: 0,
    });
  });

  it('tracks token, tool, latency, context, and cost budgets as hard per-turn limits', () => {
    const policy = CHAT_CORE_V2_REASONING_POLICIES.standard_command;
    const usage = addRuntimeBudgetUsage(makeRuntimeBudgetUsage({
      inputTokens: 2000,
      outputTokens: 200,
      modelCalls: 1,
      toolCalls: 1,
      wallClockMs: 1000,
      costUsd: 0.005,
      contextItems: 4,
    }), { inputTokens: 401 });

    expect(checkRuntimeBudget(policy, usage)).toEqual({
      ok: false,
      limit: 'input_tokens',
      used: 2401,
      max: 2400,
    });
    expect(canStartToolCall(policy, makeRuntimeBudgetUsage({ toolCalls: 1 }))).toEqual({
      ok: false,
      limit: 'tool_calls',
      used: 2,
      max: 1,
    });
  });

  it('allows explicit fallback for read-only routes but blocks unsafe write fallback', () => {
    expect(evaluateChatCoreV2Fallback({
      reason: 'v2_llm_failure',
      routeMethod: 'llm_synthesis',
      hasWriteIntent: false,
    })).toEqual({ allowed: true, reason: 'v2_llm_failure' });

    expect(evaluateChatCoreV2Fallback({
      reason: 'v2_timeout',
      routeMethod: 'llm_command_translation',
      hasWriteIntent: true,
    })).toEqual({
      allowed: false,
      reason: 'v2_timeout',
      blockedBecause: 'write_without_equivalent_safety',
    });

    expect(evaluateChatCoreV2Fallback({
      reason: 'v2_timeout',
      routeMethod: 'llm_command_translation',
      hasWriteIntent: true,
      oldPathHasEquivalentSafety: true,
    })).toEqual({ allowed: true, reason: 'v2_timeout' });
  });

  it('never falls back from a blocked route', () => {
    expect(evaluateChatCoreV2Fallback({
      reason: 'v2_unsupported',
      routeMethod: 'blocked',
      hasWriteIntent: false,
    })).toEqual({
      allowed: false,
      reason: 'v2_unsupported',
      blockedBecause: 'blocked_route',
    });
  });

  it('defaults provider storage off and requires review for financial or credential-adjacent data', () => {
    expect(resolveProviderDataPolicy({
      domain: 'finance',
      sensitivity: 'financial',
      storeRequested: true,
      backgroundModeRequested: true,
    })).toEqual({
      store: false,
      allowBackgroundMode: false,
      allowRawSensitiveContext: false,
      requiresDataProcessingReview: true,
    });

    expect(resolveProviderDataPolicy({
      domain: 'connections',
      sensitivity: 'credential_adjacent',
      storeRequested: true,
    }).store).toBe(false);
  });

  it('allows approved background mode only for non-sensitive long-running domains', () => {
    expect(resolveProviderDataPolicy({
      domain: 'content',
      sensitivity: 'personal',
      backgroundModeRequested: true,
      storeRequested: true,
    })).toEqual({
      store: true,
      allowBackgroundMode: true,
      allowRawSensitiveContext: true,
      requiresDataProcessingReview: false,
    });

    expect(resolveProviderDataPolicy({
      domain: 'secretary',
      sensitivity: 'personal',
      backgroundModeRequested: true,
    })).toMatchObject({
      allowBackgroundMode: false,
      requiresDataProcessingReview: true,
    });
  });
});
