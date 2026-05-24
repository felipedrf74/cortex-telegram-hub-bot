// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  ChatActionName,
  ChatActionSkill,
} from '../registry';
import type {
  ChatActionPlan,
  ChatClarificationReason,
  ChatPlannerInput,
  ChatPlanStep,
} from '../types';

export interface PendingNeedsInputPlanOptions {
  skill: ChatActionSkill;
  action: ChatActionName;
  question: string;
  args: Record<string, unknown>;
  routingSignals: string[];
  clarificationReason?: ChatClarificationReason;
  intentClass?: string;
}

export interface PendingContinuationHelpers {
  buildPlanFromSteps(
    input: ChatPlannerInput,
    steps: ChatPlanStep[],
    routingSignals: string[],
    confidence: number,
  ): ChatActionPlan;
  buildNeedsInputPlan(input: ChatPlannerInput, opts: PendingNeedsInputPlanOptions): ChatActionPlan;
  buildTargetedClarificationQuestion(input: ChatPlannerInput, steps: ChatPlanStep[]): string;
}
