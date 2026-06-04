// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  claimChatActionRun,
  updateChatActionRun,
  type ChatActionRunRow,
  type ChatActionRunStatus,
} from '../../chat-action-run-store';
import {
  markPendingChatActionNeedsUserFollowup,
  upsertPendingChatAction,
} from '../../chat-action-state';
import { getChatActionRegistry, riskClassForRisk, type ChatActionName } from '../registry';
import type {
  ChatActionPlan,
  ChatPlannerInput,
  ChatPlanStep,
} from '../types';
import {
  actionToStepType,
  pickExpectedFields,
} from '../../skills/step-builder';
import { missingContentAgencySlots } from '../../skills/content/helpers';
import { missingTrainingPlanSlots } from '../../skills/training/helpers';
import { logger } from '../../../utils/logger';
import { normalizeProvider } from '../planner/plan-utils';

export function rowToConfirmedStep(row: ChatActionRunRow): ChatPlanStep | null {
  const action = row.action_type as ChatActionName;
  const registryEntry = getChatActionRegistry().find((entry) => entry.action === action);
  if (!registryEntry) return null;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(row.request_json || '{}') as Record<string, unknown>;
  } catch {
    return null;
  }
  const provider = normalizeProvider(row.provider ?? args.provider) ?? registryEntry.providerDependencies[0] ?? 'nexus';
  return {
    stepId: `confirmed-${row.id}`,
    skill: registryEntry.skill,
    type: actionToStepType(action),
    action,
    risk: row.risk,
    riskClass: riskClassForRisk(row.risk),
    provider,
    args,
    requiredArgsPresent: registryEntry.requiredFields.every((field) => args[field] != null && args[field] !== ''),
    idempotencyKey: row.normalized_action_hash,
    verification: {
      required: registryEntry.verifier !== 'none',
      method: registryEntry.verifier,
      expectedFields: pickExpectedFields(args, registryEntry.requiredFields),
    },
  };
}

export function persistPlanStatus(plan: ChatActionPlan, input: ChatPlannerInput, status: ChatActionRunStatus): void {
  if (input.persistRuns === false) return;
  for (const step of plan.steps) {
    persistStepStatus(plan, input, step, status);
  }
}

export function persistStepStatus(
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  step: ChatPlanStep,
  status: ChatActionRunStatus,
): void {
  if (input.persistRuns === false) return;
  if (status === 'needs_clarification' && step.action === 'training_plan_create') {
    const args = step.args as Record<string, unknown>;
    upsertPendingChatAction({
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      skill: 'training',
      action: 'training_plan_create',
      collectedSlots: args,
      missingSlots: missingTrainingPlanSlots(args),
      riskClass: 'R1',
      locale: input.locale || plan.locale,
      timezone: input.timezone,
      originatingSurface: input.channel,
      nowIso: plan.createdAt,
    });
  }
  if (status === 'needs_clarification'
    && (step.action === 'content_brief_create' || step.action === 'content_script_create')) {
    const args = step.args as Record<string, unknown>;
    upsertPendingChatAction({
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      skill: 'content',
      action: step.action,
      collectedSlots: args,
      missingSlots: missingContentAgencySlots(step.action, args),
      riskClass: 'R1',
      locale: input.locale || plan.locale,
      timezone: input.timezone,
      originatingSurface: input.channel,
      nowIso: plan.createdAt,
    });
  }
  const claim = claimChatActionRun({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    normalizedActionHash: step.idempotencyKey,
    provider: step.provider,
    actionType: step.action,
    risk: step.risk,
    request: step.args,
    nowIso: plan.createdAt,
  });
  const accepted = updateChatActionRun(claim.row.id, status, {
    error: status === 'needs_clarification' ? { reason: 'missing_required_fields' } : undefined,
    verification: status === 'needs_confirmation' ? { required: true, reason: 'risk_policy' } : undefined,
  });
  if (!accepted) {
    logger.warn({
      runId: claim.row.id,
      userId: input.userId,
      tenantId: input.tenantId,
      attemptedStatus: status,
    }, 'chat action plan status update rejected by terminal run state');
  }
}

export function requeuePartialSuccessPendingParents(
  input: ChatPlannerInput,
  plan: ChatActionPlan,
  results: Array<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }>,
): void {
  if (input.persistRuns === false) return;
  for (const result of results) {
    if (result.status !== 'partial_success') continue;
    try {
      markPendingChatActionNeedsUserFollowup({
        userId: input.userId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        skill: result.step.skill,
        action: result.step.action,
        nowIso: plan.createdAt,
      });
    } catch (err) {
      logger.debug({
        err,
        userId: input.userId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        skill: result.step.skill,
        action: result.step.action,
      }, 'chat action pending parent requeue skipped');
    }
  }
}
