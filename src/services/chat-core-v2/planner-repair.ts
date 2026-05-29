// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatTurnPlanMicroValidationIssue } from './plan-schema';

export const CHAT_CORE_V2_PLANNER_MAX_REPAIR_ATTEMPTS = 1;
export const CHAT_CORE_V2_PLANNER_REPAIR_PROMPT_VERSION = 'chat_turn_plan_micro_repair@0.1.0';

export interface BuildPlannerRepairPromptInput {
  rawModelOutput: string;
  issues: ChatTurnPlanMicroValidationIssue[];
}

export function canAttemptPlannerRepair(attemptsAlreadyUsed: number): boolean {
  return attemptsAlreadyUsed < CHAT_CORE_V2_PLANNER_MAX_REPAIR_ATTEMPTS;
}

export function buildPlannerRepairPrompt(input: BuildPlannerRepairPromptInput): string {
  const issueSummary = input.issues
    .slice(0, 8)
    .map((issue) => `${issue.path}:${issue.code}`)
    .join(', ');
  return [
    `Repair prompt: ${CHAT_CORE_V2_PLANNER_REPAIR_PROMPT_VERSION}`,
    'Return corrected JSON only. Do not explain.',
    `Validation issues: ${issueSummary || 'unknown'}`,
    `Previous output (truncated): ${input.rawModelOutput.slice(0, 800)}`,
  ].join('\n');
}
