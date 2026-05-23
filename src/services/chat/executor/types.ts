// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  ChatActionPlan,
  ChatActionPlannerDeps,
  ChatPlannerInput,
  ChatPlanStep,
  ChatStepExecutionResult,
} from '../types';

export interface ChatStepExecutionContext {
  plan: ChatActionPlan;
  input: ChatPlannerInput;
  deps: Required<ChatActionPlannerDeps>;
  persistRuns: boolean;
  confirmed: boolean;
}

export type ChatStepExecutor = (
  step: ChatPlanStep,
  context: ChatStepExecutionContext,
) => ChatStepExecutionResult | Promise<ChatStepExecutionResult>;
