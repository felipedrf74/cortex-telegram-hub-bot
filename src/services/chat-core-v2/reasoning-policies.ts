// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ReasoningPolicy, ReasoningTier, RuntimeBudget } from './types';

const VERSION = 'chat_core_v2_reasoning_policy@1.0.0';

function budget(input: Partial<RuntimeBudget> & Pick<RuntimeBudget, 'maxModelCalls'>): RuntimeBudget {
  return {
    maxInputTokens: input.maxInputTokens ?? 0,
    maxOutputTokens: input.maxOutputTokens ?? 0,
    maxCachedInputTokens: input.maxCachedInputTokens,
    maxModelCalls: input.maxModelCalls,
    maxToolCalls: input.maxToolCalls ?? 0,
    maxWallClockMs: input.maxWallClockMs ?? 1000,
    maxCostUsd: input.maxCostUsd ?? 0,
    maxContextItems: input.maxContextItems ?? 0,
  };
}

export const CHAT_CORE_V2_REASONING_POLICIES: Record<ReasoningTier, ReasoningPolicy> = {
  none: {
    policyVersion: VERSION,
    tier: 'none',
    budget: budget({ maxModelCalls: 0, maxWallClockMs: 250, maxContextItems: 12 }),
    allowBackground: false,
    allowWriteProposal: false,
    allowMultiStepPlan: false,
    requiresHumanReview: false,
  },
  fast_extraction: {
    policyVersion: VERSION,
    tier: 'fast_extraction',
    budget: budget({
      maxModelCalls: 1,
      maxInputTokens: 1200,
      maxOutputTokens: 240,
      maxToolCalls: 0,
      maxWallClockMs: 1800,
      maxCostUsd: 0.002,
      maxContextItems: 8,
    }),
    allowBackground: false,
    allowWriteProposal: true,
    allowMultiStepPlan: false,
    requiresHumanReview: false,
  },
  standard_command: {
    policyVersion: VERSION,
    tier: 'standard_command',
    budget: budget({
      maxModelCalls: 1,
      maxInputTokens: 2400,
      maxOutputTokens: 400,
      maxToolCalls: 1,
      maxWallClockMs: 3500,
      maxCostUsd: 0.01,
      maxContextItems: 16,
    }),
    allowBackground: false,
    allowWriteProposal: true,
    allowMultiStepPlan: false,
    requiresHumanReview: false,
  },
  synthesis: {
    policyVersion: VERSION,
    tier: 'synthesis',
    budget: budget({
      maxModelCalls: 1,
      maxInputTokens: 4500,
      maxOutputTokens: 700,
      maxToolCalls: 2,
      maxWallClockMs: 5000,
      maxCostUsd: 0.025,
      maxContextItems: 24,
    }),
    allowBackground: false,
    allowWriteProposal: false,
    allowMultiStepPlan: false,
    requiresHumanReview: false,
  },
  planner: {
    policyVersion: VERSION,
    tier: 'planner',
    budget: budget({
      maxModelCalls: 2,
      maxInputTokens: 6500,
      maxOutputTokens: 900,
      maxToolCalls: 4,
      maxWallClockMs: 8000,
      maxCostUsd: 0.06,
      maxContextItems: 36,
    }),
    allowBackground: false,
    allowWriteProposal: true,
    allowMultiStepPlan: true,
    requiresHumanReview: false,
  },
  deep_planner: {
    policyVersion: VERSION,
    tier: 'deep_planner',
    budget: budget({
      maxModelCalls: 3,
      maxInputTokens: 9000,
      maxOutputTokens: 1200,
      maxToolCalls: 6,
      maxWallClockMs: 12000,
      maxCostUsd: 0.12,
      maxContextItems: 48,
    }),
    allowBackground: false,
    allowWriteProposal: true,
    allowMultiStepPlan: true,
    requiresHumanReview: true,
  },
  background_planner: {
    policyVersion: VERSION,
    tier: 'background_planner',
    budget: budget({
      maxModelCalls: 4,
      maxInputTokens: 12000,
      maxOutputTokens: 1500,
      maxToolCalls: 8,
      maxWallClockMs: 60000,
      maxCostUsd: 0.25,
      maxContextItems: 64,
    }),
    allowBackground: true,
    allowWriteProposal: true,
    allowMultiStepPlan: true,
    requiresHumanReview: true,
  },
};

export function getChatCoreV2ReasoningPolicy(tier: ReasoningTier): ReasoningPolicy {
  return CHAT_CORE_V2_REASONING_POLICIES[tier];
}
