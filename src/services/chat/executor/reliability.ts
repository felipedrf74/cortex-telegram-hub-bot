// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../../../utils/logger';
import {
  recordChatActionTelemetry,
} from '../../chat-action-state';
import { enqueueChatActionFixerReview } from '../../chat-action-fixer-worker';
import {
  normalizeChatActionErrorReason,
  runChatActionWithBoundedRetry,
  shouldQueueChatActionFixerReview,
} from '../../chat-action-retry-policy';
import type {
  ChatActionPlan,
  ChatPlannerInput,
  ChatPlanStep,
  ChatStepExecutionResult,
} from '../types';
import { unsupportedChatExecutorReason } from './response-copy';
import {
  summarizeSlotProvenance,
  thresholdForSteps,
} from './telemetry';
import { getChatStepExecutor } from './dispatch-table';
import type { ChatStepExecutionContext } from './types';

export async function executeStepWithReliability(
  step: ChatPlanStep,
  context: ChatStepExecutionContext,
): Promise<ChatStepExecutionResult> {
  const executor = getChatStepExecutor(step.action);
  if (!executor) return { step, status: 'blocked', error: unsupportedChatExecutorReason(step) };
  let result: ChatStepExecutionResult;
  try {
    result = await runChatActionWithBoundedRetry(() => executor(step, context), {
      onRetry: (event) => {
        logger.warn({
          userId: context.input.userId,
          tenantId: context.input.tenantId,
          conversationId: context.input.conversationId,
          messageId: context.input.messageId,
          skill: step.skill,
          action: step.action,
          attempt: event.attempt,
          category: event.category,
          reason: event.reason,
        }, 'Retrying transient chat action executor failure');
      },
    });
  } catch (err) {
    result = { step, status: 'failed', error: normalizeChatActionErrorReason(err).slice(0, 200) };
  }
  maybeQueueChatActionFixerReview(context.input, context.plan, step, result);
  return result;
}

function maybeQueueChatActionFixerReview(
  input: ChatPlannerInput,
  plan: ChatActionPlan,
  step: ChatPlanStep,
  result: ChatStepExecutionResult,
): void {
  if (input.persistRuns === false || result.status === 'verified_success' || !shouldQueueChatActionFixerReview(result.error)) return;
  try {
    recordChatActionTelemetry({
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      planner: plan.planner,
      status: result.status,
      skill: step.skill,
      action: step.action,
      telemetry: {
        ...(plan.telemetry ?? {
          routeTier: 'tier0_deterministic',
          candidates: [{ skill: step.skill, action: step.action, score: plan.effectiveConfidence ?? plan.confidence }],
          calibratedScore: plan.effectiveConfidence ?? plan.confidence,
          threshold: thresholdForSteps(plan.steps),
        }),
        outcome: 'requires_fixer_review',
        failureReason: result.error ?? 'unknown_error',
        verifierStatus: 'mismatch',
        predictedActionHash: step.idempotencyKey,
        slotProvenanceSummary: summarizeSlotProvenance(plan),
      },
      nowIso: input.nowIso,
    });
    enqueueChatActionFixerReview({ input, plan, step, result });
  } catch (err) {
    logger.warn({
      err,
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      skill: step.skill,
      action: step.action,
      reason: result.error,
    }, 'Chat action fixer review enqueue failed');
  }
}
