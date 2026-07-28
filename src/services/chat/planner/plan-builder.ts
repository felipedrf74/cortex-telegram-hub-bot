// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';
import type {
  ChatActionPlan,
  ChatClarificationReason,
  ChatPlannerInput,
  ChatPlanStep,
} from '../types';
import type { ChatActionName, ChatActionSkill } from '../registry';
import { buildStepIdempotencyKey, makeStep } from '../../skills/step-builder';
import { buildTargetedClarificationQuestion } from './clarification';
import {
  calibratePlanConfidence,
  shouldRequireSafeWriteConfirmation,
  stepRequiresConfirmation,
  thresholdForSteps,
} from './plan-utils';

export function buildPlanFromSteps(
  input: ChatPlannerInput,
  steps: ChatPlanStep[],
  routingSignals: string[],
  confidence: number,
): ChatActionPlan {
  const effectiveConfidence = calibratePlanConfidence(steps, confidence);
  const requireSafeWrites = shouldRequireSafeWriteConfirmation(input);
  return {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: input.nowIso ?? new Date().toISOString(),
    planner: steps.length > 1 ? 'mixed' : 'deterministic',
    steps,
    requiresConfirmation: steps.some((step) => stepRequiresConfirmation(step, { requireSafeWrites })),
    clarificationQuestion: steps.some((step) => !step.requiredArgsPresent)
      ? buildTargetedClarificationQuestion(input, steps)
      : undefined,
    clarificationReason: steps.some((step) => !step.requiredArgsPresent)
      ? 'missing_required_fields'
      : undefined,
    confidence,
    effectiveConfidence,
    telemetry: {
      routeTier: 'tier0_deterministic',
      candidates: steps.map((step) => ({ skill: step.skill, action: step.action, score: effectiveConfidence })),
      calibratedScore: effectiveConfidence,
      threshold: thresholdForSteps(steps),
      verifierStatus: steps.some((step) => step.verification.required) ? 'pending' : 'not_required',
    },
    debug: {
      routingSignals,
      rejectedFastPaths: [],
      parser: 'deterministic',
    },
  };
}

export function buildNeedsInputPlan(input: ChatPlannerInput, opts: {
  skill: ChatActionSkill;
  action: ChatActionName;
  question: string;
  args: Record<string, unknown>;
  routingSignals: string[];
  clarificationReason?: ChatClarificationReason;
  intentClass?: string;
}): ChatActionPlan {
  const step = makeStep(input, {
    skill: opts.skill,
    action: opts.action,
    risk: 'ambiguous',
    provider: 'nexus',
    args: opts.args,
    requiredArgsPresent: false,
  });
  return {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: input.nowIso ?? new Date().toISOString(),
    planner: 'deterministic',
    steps: [step],
    requiresConfirmation: false,
    clarificationQuestion: opts.question,
    clarificationReason: opts.clarificationReason ?? 'missing_required_fields',
    intentClass: opts.intentClass,
    confidence: 0.72,
    effectiveConfidence: 0.72,
    telemetry: {
      routeTier: 'tier0_deterministic',
      candidates: [{ skill: opts.skill, action: opts.action, score: 0.72 }],
      calibratedScore: 0.72,
      threshold: 0.86,
      verifierStatus: 'not_required',
      outcome: 'needs_input',
    },
    debug: {
      routingSignals: opts.routingSignals,
      rejectedFastPaths: [],
      parser: 'deterministic',
    },
  };
}

export function buildMessageOnlyPlan(input: ChatPlannerInput, text: string, signal: string): ChatActionPlan {
  const args = { text };
  const step: ChatPlanStep = {
    stepId: `step-${randomUUID()}`,
    skill: 'connections',
    type: 'answer',
    action: 'connections_status',
    risk: 'read_only',
    riskClass: 'R0',
    provider: 'none',
    args,
    requiredArgsPresent: true,
    idempotencyKey: buildStepIdempotencyKey(input, 'connections_status', args),
    verification: { required: false, method: 'none' },
  };
  return {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: input.nowIso ?? new Date().toISOString(),
    planner: 'deterministic',
    steps: [step],
    requiresConfirmation: false,
    confidence: 0.99,
    effectiveConfidence: 0.99,
    telemetry: {
      routeTier: 'tier0_deterministic',
      candidates: [{ skill: 'connections', action: 'connections_status', score: 0.99 }],
      calibratedScore: 0.99,
      threshold: 0.7,
      verifierStatus: 'not_required',
      outcome: signal,
    },
    debug: { routingSignals: [signal], rejectedFastPaths: [], parser: 'deterministic' },
  };
}

export function buildAnswerOnlyPlan(input: ChatPlannerInput, opts: {
  skill: ChatActionSkill;
  action: ChatActionName;
  text: string;
  involvedSkills: string[];
  routingSignal: string;
}): ChatActionPlan {
  const step: ChatPlanStep = {
    stepId: `step-${randomUUID()}`,
    skill: opts.skill,
    type: 'answer',
    action: opts.action,
    risk: 'read_only',
    riskClass: 'R0',
    provider: 'nexus',
    args: { text: opts.text },
    requiredArgsPresent: true,
    idempotencyKey: buildStepIdempotencyKey(input, opts.action, { text: input.text }),
    verification: { required: false, method: 'none' },
  };
  return {
    ...buildPlanFromSteps(input, [step], [opts.routingSignal], 0.99),
    involvedSkills: [...new Set(opts.involvedSkills)],
  };
}

export function buildClarificationPlan(
  input: ChatPlannerInput,
  question: string,
  involvedSkills?: string[],
): ChatActionPlan {
  return {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: input.nowIso ?? new Date().toISOString(),
    planner: 'deterministic',
    steps: [{
      stepId: `step-${randomUUID()}`,
      skill: 'secretary_calendar',
      type: 'clarification',
      action: 'schedule_event',
      risk: 'ambiguous',
      riskClass: 'R4',
      provider: 'none',
      args: {},
      requiredArgsPresent: false,
      idempotencyKey: buildStepIdempotencyKey(input, 'schedule_event', { text: input.text }),
      verification: { required: false, method: 'none' },
    }],
    ...(involvedSkills?.length ? { involvedSkills: [...new Set(involvedSkills)] } : {}),
    requiresConfirmation: false,
    clarificationQuestion: question,
    clarificationReason: 'ambiguous_intent',
    intentClass: 'clarifying_question',
    confidence: 0.4,
  };
}

export function clarificationReasonForPlan(plan: ChatActionPlan): ChatClarificationReason {
  if (plan.clarificationReason) return plan.clarificationReason;
  if (plan.telemetry && plan.effectiveConfidence != null && plan.effectiveConfidence < plan.telemetry.threshold) {
    return 'low_confidence';
  }
  return 'missing_required_fields';
}
