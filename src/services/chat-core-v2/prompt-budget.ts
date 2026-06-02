// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export const CHAT_CORE_V2_PLANNER_SOFT_TOKEN_CAP = 2_000;
export const CHAT_CORE_V2_PLANNER_HARD_TOKEN_CAP = 3_000;
export const CHAT_CORE_V2_ULTRA_COMPACT_PLANNER_TOKEN_TARGET = 512;

export type PromptBudgetDecisionKind = 'within_budget' | 'drop_optional_context' | 'clarify_or_escalate';

export interface PlannerPromptBudgetDecision {
  decision: PromptBudgetDecisionKind;
  inputTokens: number;
  softCap: number;
  hardCap: number;
  dropOrder: string[];
  reasonCodes: string[];
}

const DEFAULT_DROP_ORDER = [
  'recent_turns_older_than_limit',
  'low_confidence_entity_candidates',
  'peripheral_capability_descriptions',
  'evidence_summaries_beyond_top_k',
];

export function decidePlannerPromptBudget(inputTokens: number): PlannerPromptBudgetDecision {
  if (inputTokens > CHAT_CORE_V2_PLANNER_HARD_TOKEN_CAP) {
    return buildDecision('clarify_or_escalate', inputTokens, ['prompt_budget_overflow']);
  }
  if (inputTokens > CHAT_CORE_V2_PLANNER_SOFT_TOKEN_CAP) {
    return buildDecision('drop_optional_context', inputTokens, ['prompt_soft_cap_exceeded']);
  }
  return buildDecision('within_budget', inputTokens, []);
}

function buildDecision(
  decision: PromptBudgetDecisionKind,
  inputTokens: number,
  reasonCodes: string[],
): PlannerPromptBudgetDecision {
  return {
    decision,
    inputTokens,
    softCap: CHAT_CORE_V2_PLANNER_SOFT_TOKEN_CAP,
    hardCap: CHAT_CORE_V2_PLANNER_HARD_TOKEN_CAP,
    dropOrder: [...DEFAULT_DROP_ORDER],
    reasonCodes,
  };
}
