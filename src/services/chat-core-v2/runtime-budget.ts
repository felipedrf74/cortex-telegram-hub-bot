// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ReasoningPolicy, RuntimeBudget } from './types';

export type RuntimeBudgetLimit =
  | 'input_tokens'
  | 'output_tokens'
  | 'model_calls'
  | 'tool_calls'
  | 'wall_clock_ms'
  | 'cost_usd'
  | 'context_items';

export interface RuntimeBudgetUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  modelCalls: number;
  toolCalls: number;
  wallClockMs: number;
  costUsd: number;
  contextItems: number;
}

export interface RuntimeBudgetVerdict {
  ok: boolean;
  limit?: RuntimeBudgetLimit;
  used?: number;
  max?: number;
}

export const EMPTY_RUNTIME_BUDGET_USAGE: RuntimeBudgetUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  modelCalls: 0,
  toolCalls: 0,
  wallClockMs: 0,
  costUsd: 0,
  contextItems: 0,
};

export function makeRuntimeBudgetUsage(input: Partial<RuntimeBudgetUsage> = {}): RuntimeBudgetUsage {
  return {
    inputTokens: normalizeBudgetNumber(input.inputTokens),
    cachedInputTokens: normalizeBudgetNumber(input.cachedInputTokens),
    outputTokens: normalizeBudgetNumber(input.outputTokens),
    modelCalls: normalizeBudgetNumber(input.modelCalls),
    toolCalls: normalizeBudgetNumber(input.toolCalls),
    wallClockMs: normalizeBudgetNumber(input.wallClockMs),
    costUsd: normalizeBudgetNumber(input.costUsd),
    contextItems: normalizeBudgetNumber(input.contextItems),
  };
}

export function addRuntimeBudgetUsage(
  current: RuntimeBudgetUsage,
  delta: Partial<RuntimeBudgetUsage>,
): RuntimeBudgetUsage {
  const normalized = makeRuntimeBudgetUsage(delta);
  return {
    inputTokens: current.inputTokens + normalized.inputTokens,
    cachedInputTokens: current.cachedInputTokens + normalized.cachedInputTokens,
    outputTokens: current.outputTokens + normalized.outputTokens,
    modelCalls: current.modelCalls + normalized.modelCalls,
    toolCalls: current.toolCalls + normalized.toolCalls,
    wallClockMs: current.wallClockMs + normalized.wallClockMs,
    costUsd: current.costUsd + normalized.costUsd,
    contextItems: current.contextItems + normalized.contextItems,
  };
}

export function checkRuntimeBudget(
  budgetOrPolicy: RuntimeBudget | ReasoningPolicy,
  usage: RuntimeBudgetUsage,
): RuntimeBudgetVerdict {
  const budget = 'budget' in budgetOrPolicy ? budgetOrPolicy.budget : budgetOrPolicy;
  const checks: Array<[RuntimeBudgetLimit, number, number]> = [
    ['input_tokens', usage.inputTokens, budget.maxInputTokens],
    ['output_tokens', usage.outputTokens, budget.maxOutputTokens],
    ['model_calls', usage.modelCalls, budget.maxModelCalls],
    ['tool_calls', usage.toolCalls, budget.maxToolCalls],
    ['wall_clock_ms', usage.wallClockMs, budget.maxWallClockMs],
    ['cost_usd', usage.costUsd, budget.maxCostUsd],
    ['context_items', usage.contextItems, budget.maxContextItems],
  ];

  for (const [limit, used, max] of checks) {
    if (used > max) return { ok: false, limit, used, max };
  }

  return { ok: true };
}

export function canStartModelCall(
  budgetOrPolicy: RuntimeBudget | ReasoningPolicy,
  usage: RuntimeBudgetUsage,
): RuntimeBudgetVerdict {
  return checkRuntimeBudget(budgetOrPolicy, addRuntimeBudgetUsage(usage, { modelCalls: 1 }));
}

export function canStartToolCall(
  budgetOrPolicy: RuntimeBudget | ReasoningPolicy,
  usage: RuntimeBudgetUsage,
): RuntimeBudgetVerdict {
  return checkRuntimeBudget(budgetOrPolicy, addRuntimeBudgetUsage(usage, { toolCalls: 1 }));
}

function normalizeBudgetNumber(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value ?? 0);
}
