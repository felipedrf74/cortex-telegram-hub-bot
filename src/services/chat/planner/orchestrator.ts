// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { buildPendingContentSpecContinuation } from '../../skills/content/pending';
import { buildPendingCookingMealPlanContinuation } from '../../skills/cooking/pending';
import { buildPendingDecisionChooseContinuation } from '../../skills/decision_center/pending';
import { buildPendingFinanceCategorizeContinuation } from '../../skills/finance/pending';
import { buildPendingMailDraftContinuation } from '../../skills/mail/pending';
import { buildPendingSlotContinuationPlan } from '../../skills/training/pending';
import type { ChatActionPlan, ChatPlannerInput } from '../types';
import type { PendingContinuationHelpers } from './pending-types';
import {
  buildNeedsInputPlan,
  buildPlanFromSteps,
} from './plan-builder';
import { buildTargetedClarificationQuestion } from './clarification';
import { shouldRunActionPlannerBeforeReadOnlyFastPaths } from './preflight-gates';
import {
  buildAmbiguousActionClarificationPlan,
  buildPendingCancellationPlan,
  buildRecentEntityFollowUpPlan,
} from './preflight-plans';
import { tryBuildMultiStepChatActionPlan } from './multi-step';
import { buildSingleActionChatActionPlan } from './single-action';
import { buildDeterministicChatActionPlan } from './deterministic';

const PENDING_CONTINUATION_HELPERS: PendingContinuationHelpers = {
  buildPlanFromSteps,
  buildNeedsInputPlan,
  buildTargetedClarificationQuestion,
};

export async function buildChatActionPlan(input: ChatPlannerInput): Promise<ChatActionPlan | null> {
  const cancellation = buildPendingCancellationPlan(input);
  if (cancellation) return cancellation;

  // Publication requests must fail closed before a pending Content brief can
  // absorb words such as "hook" or "tomorrow" as harmless specifications.
  const publicationBoundary = buildDeterministicChatActionPlan(input);
  if (publicationBoundary?.steps[0]?.action === 'content_publish_now') {
    return publicationBoundary;
  }

  const pendingContinuation = buildPendingSlotContinuationPlan(input, PENDING_CONTINUATION_HELPERS);
  if (pendingContinuation) return pendingContinuation;
  // Phase 7 close-out (2026-05-15): cooking pending-meal-plan continuation.
  // Mirrors the training-plan continuation: when the user has a pending
  // cooking_meal_plan and the new turn supplies dietary constraints
  // ("high-protein, vegetarian", "low-carb, no fish"), apply them as
  // additional args and re-emit the plan step.
  const cookingPendingContinuation = buildPendingCookingMealPlanContinuation(input, PENDING_CONTINUATION_HELPERS);
  if (cookingPendingContinuation) return cookingPendingContinuation;
  // Phase 8 batch 38 (2026-05-15): mail draft refinement continuation.
  const mailPendingContinuation = buildPendingMailDraftContinuation(input, PENDING_CONTINUATION_HELPERS);
  if (mailPendingContinuation) return mailPendingContinuation;
  // Phase 8 batch 38: decision_choose with sub-options continuation.
  const decisionPendingContinuation = buildPendingDecisionChooseContinuation(input, PENDING_CONTINUATION_HELPERS);
  if (decisionPendingContinuation) return decisionPendingContinuation;
  // Phase 8 batch 38: finance categorize-receipt category continuation.
  const financePendingContinuation = buildPendingFinanceCategorizeContinuation(input, PENDING_CONTINUATION_HELPERS);
  if (financePendingContinuation) return financePendingContinuation;
  // Phase 9 batch 44 (2026-05-16): content brief / script-create pending
  // continuation. Turn 1 invokes the brief / script intent; turn 2 supplies
  // additional spec (audience, platform-specific tone, length target).
  const contentPendingContinuation = buildPendingContentSpecContinuation(input, PENDING_CONTINUATION_HELPERS);
  if (contentPendingContinuation) return contentPendingContinuation;

  const multiStep = await tryBuildMultiStepChatActionPlan(input, singleActionPlanner);
  if (multiStep) return multiStep;

  const recentFollowUp = buildRecentEntityFollowUpPlan(input);
  if (recentFollowUp) return recentFollowUp;

  const ambiguousAction = buildAmbiguousActionClarificationPlan(input);
  if (ambiguousAction) return ambiguousAction;

  if (!shouldRunActionPlannerBeforeReadOnlyFastPaths(input.text)) return null;

  return singleActionPlanner(input);
}

function singleActionPlanner(input: ChatPlannerInput): Promise<ChatActionPlan | null> {
  return buildSingleActionChatActionPlan(input, buildDeterministicChatActionPlan);
}
