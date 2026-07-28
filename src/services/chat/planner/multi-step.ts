// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { splitChatMultiStepRequest } from '../../chat-multi-step-splitter';
import { routeChatMultiStepSegments } from '../../chat-segment-router';
import type {
  ChatActionPlan,
  ChatPlannerInput,
} from '../types';
import { buildClarificationPlan } from './plan-builder';
import {
  enforceCrossSkillPreview,
  executableSkillsForPlan,
  isCrossSkillExecutionEnabled,
} from './cross-skill-ownership';

export type SingleActionPlanBuilder = (input: ChatPlannerInput) => Promise<ChatActionPlan | null>;

export async function tryBuildMultiStepChatActionPlan(
  input: ChatPlannerInput,
  buildSingleActionPlan: SingleActionPlanBuilder,
): Promise<ChatActionPlan | null> {
  const split = splitChatMultiStepRequest(input.text);
  if (split.classification === 'single' || split.segments.length < 2) return null;
  const routed = await routeChatMultiStepSegments(input, split.segments, buildSingleActionPlan);
  if (routed.plan) {
    // M16: low_confidence_multi NEVER silently executes — the DAG already
    // forces requiresConfirmation for >=2 steps, and we force it again here
    // explicitly so a future single-step collapse can not bypass the
    // preview. The confirmation preview enumerates the interpreted steps
    // (see multiStepPreviewCopy in executor/response-copy.ts).
    const lowConfidence = split.classification === 'low_confidence_multi';
    // M19 (flag AI_CROSS_SKILL_EXECUTION, default OFF → byte-identical):
    // any plan spanning >=2 skills is preview-first, and the splitter's own
    // cross-skill detection ('cross_skill_action_segments') is recorded as
    // a planner input signal. The flag also retires cross_skill_bridge;
    // planner-declined actionable turns stop at the deterministic
    // cross_skill_plan_declined terminal instead of silently dropping work.
    const crossSkillActive = isCrossSkillExecutionEnabled();
    const spansSkills = crossSkillActive && executableSkillsForPlan(routed.plan.steps).length >= 2;
    return {
      ...(crossSkillActive ? enforceCrossSkillPreview(routed.plan) : routed.plan),
      requiresConfirmation: routed.plan.requiresConfirmation || lowConfidence || spansSkills,
      // M16: segments beyond the splitter cap are disclosed in response copy.
      ...(split.overflowCount > 0 ? { multiStepOverflowCount: split.overflowCount } : {}),
      confidence: Math.min(routed.plan.confidence, split.confidence),
      effectiveConfidence: Math.min(routed.plan.effectiveConfidence ?? routed.plan.confidence, split.confidence),
      telemetry: routed.plan.telemetry
        ? {
            ...routed.plan.telemetry,
            calibratedScore: Math.min(routed.plan.telemetry.calibratedScore, split.confidence),
          }
        : routed.plan.telemetry,
      debug: {
        routingSignals: [
          ...(routed.plan.debug?.routingSignals ?? []),
          `multi_step_split_reason:${split.reason}`,
          ...(crossSkillActive && split.reason === 'cross_skill_action_segments'
            ? ['cross_skill_intent_plan_input']
            : []),
          ...(lowConfidence ? ['multi_step_low_confidence_preview'] : []),
          ...(split.overflowCount > 0 ? [`multi_step_overflow:${split.overflowCount}`] : []),
        ],
        rejectedFastPaths: routed.plan.debug?.rejectedFastPaths ?? [],
        parser: 'mixed',
        modelProvider: routed.plan.debug?.modelProvider,
      },
    };
  }
  if (routed.blockedReason === 'segment_unresolved') {
    return buildClarificationPlan(input, input.locale?.startsWith('pt')
      ? 'Vejo mais de uma ação, mas preciso que separes melhor cada passo antes de executar.'
      : 'I see more than one action, but I need you to separate each step more clearly before I run it.');
  }
  return null;
}
