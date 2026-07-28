// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from './chat/types';
import type { ChatMultiStepSegment } from './chat-multi-step-splitter';
import { buildChatMultiStepDag, isRelaxedChatMultiStepConnective } from './chat-multi-step-dag';
import { findChatActionDefinition } from './chat/registry';
import {
  applyCrossSkillOwnershipToSteps,
  isCrossSkillExecutionEnabled,
} from './chat/planner/cross-skill-ownership';

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
    // M19 (flag AI_CROSS_SKILL_EXECUTION, default OFF → byte-identical):
    // manifest-driven ownership rewrite runs after the segment's plan build
    // and before pronoun/$ref resolution + DAG construction, so a step that
    // targets a capability another skill OWNS (e.g. "add it to my calendar"
    // — agenda placement is Secretary's) executes through the owner action
    // instead of a misrouted lookalike. The step is REWRITTEN, never
    // duplicated.
    let segmentSteps = segmentPlan.steps;
    if (isCrossSkillExecutionEnabled()) {
      const owned = applyCrossSkillOwnershipToSteps(segmentSteps, segment.text, input);
      segmentSteps = owned.steps;
      for (const rewrite of owned.rewrites) {
        signals.push(`cross_skill_ownership_rewrite:${rewrite.fromSkill}.${rewrite.fromAction}->${rewrite.toSkill}.${rewrite.toAction}`);
      }
    }
    const resolvedSegmentSteps = segmentSteps.map((step) => resolvePronounReferenceForStep(step, segment, steps));
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

// M16 (multi-step upgrade): pronoun -> $ref wiring is registry-driven.
//
// Before M16 this function held a hardcoded tasks-only action list; now a
// producer step DECLARES its chainable result entities via
// ChatActionDefinition.outputRefs (e.g. create_task -> { taskId: 'task.id' },
// schedule_event -> { eventId: 'event.id' }) and a consumer step's missing
// required/optional fields are matched against those declarations. This is
// what makes the cross-domain chain ("create the workout task and add it to
// my calendar") resolvable without per-action branches.
function resolvePronounReferenceForStep(
  step: ChatPlanStep,
  segment: ChatMultiStepSegment,
  priorSteps: ChatPlanStep[],
): ChatPlanStep {
  if (step.type === 'answer' || step.type === 'clarification') return step;
  const definition = findChatActionDefinition(step.skill, step.action);
  if (!definition) return step;
  const pronounAnchored = segment.pronounMentions.length > 0;
  // M16 adversarial fix (data-need chaining): a relaxed-connective segment
  // ('and'/'e'/'y'/','/…) whose action is missing a REQUIRED field that a
  // prior step's registry outputRefs can produce is data-linked even when
  // pronoun extraction recognized nothing ("add milk" after "create a
  // grocery list"). Only required fields are wired on this path — optional
  // fields still need an explicit anaphora signal.
  const dataNeedEligible = !pronounAnchored
    && priorSteps.length > 0
    && isRelaxedChatMultiStepConnective(segment.connective)
    && definition.requiredFields.some((field) => isMissingArg(step.args[field]));
  if (!pronounAnchored && !dataNeedEligible) return step;
  const wirableFields = (pronounAnchored
    ? [...definition.requiredFields, ...definition.optionalFields]
    : definition.requiredFields
  ).filter((field) => isMissingArg(step.args[field]));
  if (wirableFields.length === 0) return step;

  const producer = findLatestProducerForFields(priorSteps, wirableFields);
  if (!producer) return step;

  const args = { ...step.args };
  for (const field of wirableFields) {
    const resultPath = producer.outputRefs[field];
    if (!resultPath) continue;
    args[field] = { $ref: `step_${producer.index + 1}.result.${resultPath}` };
  }

  // A step becomes executable once every REQUIRED field is satisfied by a
  // concrete arg or a wired $ref. (Generalizes the pre-M16 force-ready rule
  // for complete_task/delete_task to every action, schema-driven.)
  const requiredArgsPresent = step.requiredArgsPresent
    || definition.requiredFields.every((field) => !isMissingArg(args[field]));
  return {
    ...step,
    args,
    requiredArgsPresent,
  };
}

function isMissingArg(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function findLatestProducerForFields(
  priorSteps: ChatPlanStep[],
  fields: string[],
): { index: number; outputRefs: Record<string, string> } | null {
  for (let index = priorSteps.length - 1; index >= 0; index -= 1) {
    const prior = priorSteps[index];
    if (prior.type === 'answer' || prior.type === 'clarification') continue;
    const definition = findChatActionDefinition(prior.skill, prior.action);
    const outputRefs = definition?.outputRefs;
    if (!outputRefs) continue;
    if (fields.some((field) => outputRefs[field] !== undefined)) {
      return { index, outputRefs };
    }
  }
  return null;
}
