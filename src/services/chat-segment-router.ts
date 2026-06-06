// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from './chat/types';
import type { ChatMultiStepSegment } from './chat-multi-step-splitter';
import { buildChatMultiStepDag } from './chat-multi-step-dag';

export type ChatSegmentPlanBuilder = (input: ChatPlannerInput) => Promise<ChatActionPlan | null>;

export interface RouteChatSegmentsResult {
  plan: ChatActionPlan | null;
  blockedReason?: 'segment_unresolved' | 'segment_refused' | 'cycle' | 'empty';
}

export async function routeChatMultiStepSegments(
  input: ChatPlannerInput,
  segments: ChatMultiStepSegment[],
  buildSegmentPlan: ChatSegmentPlanBuilder,
): Promise<RouteChatSegmentsResult> {
  const steps: ChatPlanStep[] = [];
  const signals: string[] = ['multi_step_segment_router'];
  let confidence = 1;
  let requiresConfirmation = false;

  for (const segment of segments) {
    const segmentPlan = await buildSegmentPlan({
      ...input,
      text: segment.text,
      messageId: `${input.messageId}:segment-${segment.index + 1}`,
    });
    if (!segmentPlan || segmentPlan.steps.length === 0) {
      return { plan: null, blockedReason: 'segment_unresolved' };
    }
    if (segmentPlan.steps.some((step) => typeof step.args?.rejectionReason === 'string')) {
      return { plan: segmentPlan, blockedReason: 'segment_refused' };
    }
    const resolvedSegmentSteps = segmentPlan.steps.map((step) => resolvePronounReferenceForStep(step, segment, steps));
    steps.push(...resolvedSegmentSteps);
    confidence = Math.min(confidence, segmentPlan.effectiveConfidence ?? segmentPlan.confidence);
    requiresConfirmation = requiresConfirmation || segmentPlan.requiresConfirmation;
    signals.push(...(segmentPlan.debug?.routingSignals ?? []));
  }

  const base: ChatActionPlan = {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: input.nowIso ?? new Date().toISOString(),
    planner: 'mixed',
    steps,
    requiresConfirmation,
    clarificationQuestion: steps.some((step) => !step.requiredArgsPresent)
      ? buildSegmentClarification(input, steps)
      : undefined,
    clarificationReason: steps.some((step) => !step.requiredArgsPresent) ? 'missing_required_fields' : undefined,
    confidence,
    effectiveConfidence: confidence,
    telemetry: {
      routeTier: 'tier0_deterministic',
      candidates: steps.map((step) => ({ skill: step.skill, action: step.action, score: confidence })),
      calibratedScore: confidence,
      threshold: 0.72,
      verifierStatus: steps.some((step) => step.verification.required) ? 'pending' : 'not_required',
    },
    debug: {
      routingSignals: [...new Set(signals)],
      rejectedFastPaths: [],
      parser: 'mixed',
    },
  };

  const dag = buildChatMultiStepDag({ plan: base, segments });
  if (!dag.ok) return { plan: null, blockedReason: dag.reason };
  return { plan: dag.plan };
}

function buildSegmentClarification(input: ChatPlannerInput, steps: ChatPlanStep[]): string {
  const missing = steps.find((step) => !step.requiredArgsPresent);
  const label = missing ? `${missing.skill}.${missing.action}` : 'that step';
  return input.locale?.startsWith('pt')
    ? `Preciso de mais um detalhe para completar ${label} antes de executar o plano completo.`
    : `I need one more detail for ${label} before I run the full plan.`;
}

function resolvePronounReferenceForStep(
  step: ChatPlanStep,
  segment: ChatMultiStepSegment,
  priorSteps: ChatPlanStep[],
): ChatPlanStep {
  if (segment.pronounMentions.length === 0) return step;
  if (!['complete_task', 'delete_task', 'update_task', 'set_task_reminder'].includes(step.action)) return step;
  const previousTaskIndex = findPreviousTaskCreationIndex(priorSteps);
  if (previousTaskIndex < 0) return step;
  const args = { ...step.args };
  if (args.taskId == null || args.taskId === '') {
    args.taskId = { $ref: `step_${previousTaskIndex + 1}.result.task.id` };
  }
  if (args.listId == null || args.listId === '') {
    args.listId = { $ref: `step_${previousTaskIndex + 1}.result.task.listId` };
  }
  const requiredArgsPresent = step.action === 'complete_task' || step.action === 'delete_task'
    ? true
    : step.requiredArgsPresent;
  return {
    ...step,
    args,
    requiredArgsPresent,
  };
}

function findPreviousTaskCreationIndex(priorSteps: ChatPlanStep[]): number {
  for (let index = priorSteps.length - 1; index >= 0; index -= 1) {
    const step = priorSteps[index];
    if (step.skill === 'tasks' && ['create_task', 'create_task_with_subtasks', 'create_checklist'].includes(step.action)) {
      return index;
    }
  }
  return -1;
}
