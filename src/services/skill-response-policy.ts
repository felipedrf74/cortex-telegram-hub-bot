// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  NexusChatExpectedResponseShape,
  NexusChatGroundingRequirement,
  NexusChatOwnerSkill,
  NexusChatRouteKind,
} from './chat-answer-contract';

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
  {
    skill: 'secretary',
    genericAnswerExamples: ['how should I think about prioritizing a busy day?'],
    localReadExamples: ['what should I do next today?', 'show my agenda', 'do I have free time?'],
    internetEligibleExamples: ['what public holiday affects my agenda next week?'],
    actionExamples: ['schedule focus time', 'move my meeting'],
    defaultGenericShape: 'direct_answer',
    defaultLocalShape: 'agenda_summary',
    defaultGrounding: 'none',
    telemetryLabel: 'chat.skill.secretary',
  },
  {
    skill: 'tasks',
    genericAnswerExamples: ['how should I break a big task down?'],
    localReadExamples: ['what tasks are overdue?', 'what should I complete first?'],
    internetEligibleExamples: ['what is a good GTD workflow?'],
    actionExamples: ['create a task', 'mark this task done', 'delete all my tasks'],
    defaultGenericShape: 'direct_answer',
    defaultLocalShape: 'task_options',
    defaultGrounding: 'none',
    telemetryLabel: 'chat.skill.tasks',
  },
  {
    skill: 'training',
    genericAnswerExamples: ['how should I structure a simple strength plan?'],
    localReadExamples: ['what is my training plan today?', 'am I recovered enough?'],
    internetEligibleExamples: ['latest marathon taper guidance'],
    actionExamples: ['create a training plan', 'move this workout'],
    defaultGenericShape: 'training_advice',
    defaultLocalShape: 'training_advice',
    defaultGrounding: 'none',
    telemetryLabel: 'chat.skill.training',
  },
  {
    skill: 'content',
    genericAnswerExamples: ['give me title ideas', 'rewrite this hook'],
    localReadExamples: ['what content drafts are ready?', 'what voice card are we using?'],
    internetEligibleExamples: ['fresh research for this topic', 'latest trend about AI'],
    actionExamples: ['generate a draft', 'expand this section'],
    defaultGenericShape: 'content_draft',
    defaultLocalShape: 'content_draft',
    defaultGrounding: 'none',
    telemetryLabel: 'chat.skill.content',
  },
  {
    skill: 'cooking',
    genericAnswerExamples: ['suggest an oven-baked kibbeh recipe', 'how do I store grated carrots?'],
    localReadExamples: ['what meals did I plan this week?', 'what is on my grocery list?'],
    internetEligibleExamples: ['latest food safety guidance for leftovers'],
    actionExamples: ['create a grocery list', 'add this dinner to my plan'],
    defaultGenericShape: 'recipe',
    defaultLocalShape: 'direct_answer',
    defaultGrounding: 'none',
    telemetryLabel: 'chat.skill.cooking',
  },
  {
    skill: 'finance',
    genericAnswerExamples: ['explain what a deductible expense is'],
    localReadExamples: ['how much did I spend this month?', 'what bills are due?'],
    internetEligibleExamples: ['current exchange rate', 'latest tax deadline'],
    actionExamples: ['categorize this receipt', 'mark this bill paid'],
    defaultGenericShape: 'finance_summary',
    defaultLocalShape: 'finance_summary',
    defaultGrounding: 'none',
    telemetryLabel: 'chat.skill.finance',
  },
  {
    skill: 'connections',
    genericAnswerExamples: ['what is Google Calendar used for in Nexus?'],
    localReadExamples: ['is Gmail connected?', 'why is Apple Health unavailable?'],
    internetEligibleExamples: ['current Google OAuth status page'],
    actionExamples: ['retry sync', 'open connection settings'],
    defaultGenericShape: 'connection_status',
    defaultLocalShape: 'connection_status',
    defaultGrounding: 'none',
    telemetryLabel: 'chat.skill.connections',
  },
  {
    skill: 'notifications',
    genericAnswerExamples: ['how do quiet hours work?'],
    localReadExamples: ['why did I miss this notification?', 'show my alert settings'],
    internetEligibleExamples: ['current APNs status'],
    actionExamples: ['turn on decision alerts', 'test push notification'],
    defaultGenericShape: 'notification_summary',
    defaultLocalShape: 'notification_summary',
    defaultGrounding: 'none',
    telemetryLabel: 'chat.skill.notifications',
  },
  {
    skill: 'decision_center',
    genericAnswerExamples: ['how should I compare two options?'],
    localReadExamples: ['what decisions are waiting?', 'why does it say all clear?'],
    internetEligibleExamples: ['decision framework examples from current sources'],
    actionExamples: ['choose this option', 'snooze this decision'],
    defaultGenericShape: 'decision_summary',
    defaultLocalShape: 'decision_summary',
    defaultGrounding: 'none',
    telemetryLabel: 'chat.skill.decision_center',
  },
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
