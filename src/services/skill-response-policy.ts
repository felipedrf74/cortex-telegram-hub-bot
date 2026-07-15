// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  NexusChatExpectedResponseShape,
  NexusChatGroundingRequirement,
  NexusChatOwnerSkill,
  NexusChatRouteKind,
} from './chat-answer-contract';
import { getCapabilityResponsePolicies } from './capability-manifest';

export interface SkillResponsePolicy {
  skill: NexusChatOwnerSkill;
  genericAnswerExamples: string[];
  localReadExamples: string[];
  internetEligibleExamples: string[];
  actionExamples: string[];
  defaultGenericShape: NexusChatExpectedResponseShape;
  defaultLocalShape: NexusChatExpectedResponseShape;
  defaultGrounding: NexusChatGroundingRequirement;
  telemetryLabel: string;
}

export const SKILL_RESPONSE_POLICIES: SkillResponsePolicy[] = [
  ...getCapabilityResponsePolicies().map((policy): SkillResponsePolicy => ({
    ...policy,
    skill: policy.skill as NexusChatOwnerSkill,
  })),
  {
    skill: 'chat',
    genericAnswerExamples: ['hello', 'what can you help with?'],
    localReadExamples: [],
    internetEligibleExamples: ['search the web for this'],
    actionExamples: [],
    defaultGenericShape: 'direct_answer',
    defaultLocalShape: 'direct_answer',
    defaultGrounding: 'none',
    telemetryLabel: 'chat.skill.general',
  },
];

const POLICY_BY_SKILL = new Map(SKILL_RESPONSE_POLICIES.map((policy) => [policy.skill, policy]));

export function getSkillResponsePolicy(skill: NexusChatOwnerSkill): SkillResponsePolicy {
  return POLICY_BY_SKILL.get(skill) ?? POLICY_BY_SKILL.get('chat')!;
}

export function expectedShapeForRoute(
  skill: NexusChatOwnerSkill,
  routeKind: NexusChatRouteKind,
): NexusChatExpectedResponseShape {
  const policy = getSkillResponsePolicy(skill);
  if (routeKind === 'local_read' || routeKind === 'action' || routeKind === 'repair') {
    return policy.defaultLocalShape;
  }
  return policy.defaultGenericShape;
}
