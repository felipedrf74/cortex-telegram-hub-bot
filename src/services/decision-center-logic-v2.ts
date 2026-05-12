// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  NotificationActionButton,
  NotificationIntentType,
  NotificationPriority,
  NotificationPrivacyPolicy,
  NotificationSourceSkill,
} from './notification-orchestrator';

export type DecisionQualityStatus = 'pass' | 'needs_enrichment' | 'internal_only' | 'blocked';
export type AutomationEligibility = 'never' | 'ask_first' | 'safe_auto_handle' | 'user_opt_in_required';
export type DecisionVisibilityScope = 'user_private' | 'tenant_shared' | 'tenant_admin' | 'system_admin';
export type DecisionNotificationEligibility = 'none' | 'digest' | 'silent_refresh' | 'visible';

export interface DecisionLogicContext {
  entityTitle?: string | null;
  currentStartAt?: string | null;
  currentEndAt?: string | null;
  recommendedStartAt?: string | null;
  recommendedEndAt?: string | null;
  sourceState?: string | null;
  explicitNoRelatedEntityReason?: string | null;
  providerName?: string | null;
  deadlineAt?: string | null;
}

export interface DecisionLogicInput {
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  priority: NotificationPriority;
  title: string;
  body: string;
  safeBody?: string | null;
  actions: NotificationActionButton[];
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  deadlineAt?: string | null;
  expiresAt?: string | null;
  privacyClassification: NotificationPrivacyPolicy;
  visibilityScope?: DecisionVisibilityScope;
  context?: DecisionLogicContext;
}

export interface DecisionQualityGateResult {
  status: DecisionQualityStatus;
  missingFields: string[];
  qualityScore: number;
  reason: string;
  safeToShowUser: boolean;
  safeForHomePreview: boolean;
  safeForAPNs: boolean;
}

export interface DecisionWhy {
  facts: string[];
  preferences: string[];
  rules: string[];
  tradeoffs: string[];
  uncertainty: string[];
}

export interface DecisionWhatWillChange {
  item: string;
  effect: string;
  targetSkill: NotificationSourceSkill;
  verificationMethod: string;
}

export interface DecisionLogicV2 {
  title: string;
  problemStatement: string;
  recommendation: string;
  expectedEffect: string;
  impactIfIgnored: string;
  primaryActionLabel: string;
  secondaryActionLabels: string[];
  whySummary: string;
  urgencyReason: string;
  confidence: number;
  qualityScore: number;
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  relatedEntityReason: string | null;
  privacyClassification: NotificationPrivacyPolicy;
  visibilityScope: DecisionVisibilityScope;
  why: DecisionWhy;
  whatWillChange: DecisionWhatWillChange[];
  readBackVerifier: string | null;
  automationEligibility: AutomationEligibility;
  autopilotPolicy: string;
  notificationEligibility: DecisionNotificationEligibility;
  apnsInterruptionLevel: 'passive' | 'active' | 'time-sensitive';
  safePreviewTitle: string;
  safePreviewBody: string;
  collapseKey: string | null;
  badgeContribution: boolean;
  riskIfIgnored: 'low' | 'medium' | 'high';
  quality: DecisionQualityGateResult;
}

export interface SecretaryDecisionAdvisorInput {
  title: string;
  currentStartAt?: string | null;
  currentEndAt?: string | null;
  availableSlots?: Array<{ startAt: string; endAt: string; label?: string }>;
  preferredWindowLabel?: string | null;
  reasonCodes?: string[];
}

export interface SecretaryDecisionAdvice {
  bestAction: string;
  alternatives: Array<{ label: string; startAt?: string; endAt?: string; tradeoff: string }>;
  feasibility: 'feasible' | 'needs_enrichment' | 'blocked';
  conflictGraph: string[];
  capacityImpact: string;
  scheduleImpact: string;
  expectedEffect: string;
  impactIfIgnored: string;
  confidence: number;
  whyFacts: string[];
  whyPreferences: string[];
  whyRules: string[];
  whyTradeoffs: string[];
  automationEligibility: AutomationEligibility;
}

export interface DecisionRankResult {
  priorityScore: number;
  homeVisible: boolean;
  section: 'needs_input' | 'schedule_conflicts' | 'approvals' | 'waiting_on_systems' | 'handled_by_nexus' | 'history';
  apnsEligible: boolean;
  digestEligible: boolean;
  autoHandleEligible: boolean;
  groupingKey: string | null;
}

const MUTATING_ACTION_IDS = new Set([
  'approve_script',
  'request_rewrite',
  'accept_reflow',
  'choose_another_time',
  'retry',
  'option_a',
  'option_b',
  'mark_paid',
  'add_meal',
  'undo_reflow',
]);

const GENERIC_COPY_PATTERNS = [
  /^secretary$/i,
  /^secretary needs your attention/i,
  /^nexus needs your attention/i,
  /^nexus needs your judgment/i,
  /^nexus found a schedule or capacity conflict/i,
  /^a schedule conflict needs your decision/i,
  /^schedule conflict needs review$/i,
  /^review$/i,
  /^open nexus to view details/i,
  /^this item needs a decision before nexus acts/i,
];

export function buildDecisionLogicV2(input: DecisionLogicInput): DecisionLogicV2 {
  const recipe = recipeForInput(input);
  const quality = evaluateDecisionQuality(input, recipe);
  const rank = rankDecision(input, recipe, quality);
  return {
    ...recipe,
    qualityScore: quality.qualityScore,
    sourceSkill: input.sourceSkill,
    type: input.type,
    privacyClassification: input.privacyClassification,
    visibilityScope: input.visibilityScope ?? 'user_private',
    notificationEligibility: rank.apnsEligible ? 'visible' : rank.digestEligible ? 'digest' : 'none',
    apnsInterruptionLevel: rank.apnsEligible && input.priority === 'time_sensitive' ? 'time-sensitive' : 'active',
    badgeContribution: rank.apnsEligible || input.priority === 'time_sensitive' || input.priority === 'critical',
    collapseKey: quality.safeForAPNs ? `${input.sourceSkill}:${input.type}:${input.relatedEntityId ?? 'none'}` : null,
    quality,
  };
}

export function evaluateDecisionQuality(
  input: DecisionLogicInput,
  recipe: Omit<DecisionLogicV2, 'sourceSkill' | 'type' | 'privacyClassification' | 'visibilityScope' | 'notificationEligibility' | 'apnsInterruptionLevel' | 'safePreviewTitle' | 'safePreviewBody' | 'collapseKey' | 'badgeContribution' | 'quality' | 'qualityScore'> & {
    safePreviewTitle: string;
    safePreviewBody: string;
    notificationEligibility?: DecisionNotificationEligibility;
  },
): DecisionQualityGateResult {
  const missingFields: string[] = [];
  const primary = primaryAction(input.actions);
  const mutating = input.actions.some((action) => MUTATING_ACTION_IDS.has(action.id));

  requireConcrete(recipe.problemStatement, 'problemStatement', missingFields);
  requireConcrete(recipe.recommendation, 'recommendation', missingFields);
  requireConcrete(recipe.expectedEffect, 'expectedEffect', missingFields);
  requireConcrete(recipe.whySummary, 'whySummary', missingFields);
  requireConcrete(recipe.urgencyReason, 'urgencyReason', missingFields);
  requirePresent(input.sourceSkill, 'sourceSkill', missingFields);
  requirePresent(input.type, 'type', missingFields);
  requireConcrete(recipe.primaryActionLabel, 'primaryActionLabel', missingFields);
  requirePresent(input.privacyClassification, 'privacyClassification', missingFields);

  if (!primary) missingFields.push('primaryAction');
  if (!input.relatedEntityId && !input.context?.explicitNoRelatedEntityReason) {
    missingFields.push('relatedEntity');
  }
  if (mutating && !recipe.readBackVerifier) {
    missingFields.push('readBackVerifier');
  }
  if (recipe.confidence <= 0 || recipe.confidence > 1) {
    missingFields.push('confidence');
  }
  const rawCopyGeneric = isGenericCopy(input.title) || isGenericCopy(input.safeBody ?? input.body);
  const enrichedCopyStillWeak = recipe.confidence < 0.6 || isGenericCopy(recipe.problemStatement) || isGenericCopy(recipe.whySummary);
  if ((rawCopyGeneric && enrichedCopyStillWeak) || isGenericCopy(recipe.problemStatement) || isGenericCopy(recipe.whySummary)) {
    missingFields.push('concreteCopy');
  }
  if (primary && isGenericCopy(primary.label) && isGenericCopy(recipe.primaryActionLabel)) {
    missingFields.push('concretePrimaryActionLabel');
  }

  const filled = 13 - missingFields.length;
  const score = Math.max(0, Math.min(100, Math.round((filled / 13) * 100)));
  const status: DecisionQualityStatus = missingFields.length === 0
    ? 'pass'
    : missingFields.includes('concreteCopy') || missingFields.includes('relatedEntity') || missingFields.includes('readBackVerifier')
      ? 'needs_enrichment'
      : 'blocked';

  return {
    status,
    missingFields,
    qualityScore: score,
    reason: missingFields.length === 0
      ? 'decision has concrete problem, recommendation, expected effect, privacy, and verification metadata'
      : `decision is missing ${missingFields.join(', ')}`,
    safeToShowUser: status === 'pass',
    safeForHomePreview: status === 'pass' && recipe.safePreviewTitle.trim().length > 0 && recipe.safePreviewBody.trim().length > 0,
    safeForAPNs: status === 'pass' && isVisiblePushCandidate(input),
  };
}

export function adviseSecretaryDecision(input: SecretaryDecisionAdvisorInput): SecretaryDecisionAdvice {
  const current = formatWindow(input.currentStartAt, input.currentEndAt);
  const feasibleSlots = (input.availableSlots ?? []).filter((slot) => isValidWindow(slot.startAt, slot.endAt));
  const best = feasibleSlots[0] ?? null;
  const title = input.title.trim() || 'schedule item';
  const conflictGraph = [
    current ? `${title} currently affects ${current}.` : `${title} is missing a concrete current schedule window.`,
    best ? `A feasible alternative exists at ${formatWindow(best.startAt, best.endAt)}.` : 'No feasible alternative slot was supplied.',
  ];

  if (!best) {
    return {
      bestAction: 'Collect schedule context before asking the user.',
      alternatives: [],
      feasibility: 'needs_enrichment',
      conflictGraph,
      capacityImpact: 'Unknown until availability is read.',
      scheduleImpact: 'Nexus cannot safely reflow without a candidate slot.',
      expectedEffect: 'Decision remains internal until Secretary has a feasible recommendation.',
      impactIfIgnored: 'The conflict may remain unresolved.',
      confidence: 0.38,
      whyFacts: conflictGraph,
      whyPreferences: input.preferredWindowLabel ? [`Preference considered: ${input.preferredWindowLabel}.`] : [],
      whyRules: ['Secretary must not recommend impossible slots.'],
      whyTradeoffs: ['Waiting for availability is safer than showing a vague decision.'],
      automationEligibility: 'never',
    };
  }

  return {
    bestAction: `Move to ${formatWindow(best.startAt, best.endAt)}.`,
    alternatives: feasibleSlots.slice(1, 4).map((slot) => ({
      label: slot.label ?? formatWindow(slot.startAt, slot.endAt) ?? 'Alternative slot',
      startAt: slot.startAt,
      endAt: slot.endAt,
      tradeoff: 'Alternative slot is feasible but lower priority than the recommended window.',
    })),
    feasibility: 'feasible',
    conflictGraph,
    capacityImpact: input.reasonCodes?.includes('overcapacity')
      ? 'Reduces pressure on an over-capacity window.'
      : 'Keeps the schedule change bounded to the affected item.',
    scheduleImpact: `Updates the affected schedule item to ${formatWindow(best.startAt, best.endAt)}.`,
    expectedEffect: `Secretary reflows the item and verifies the new window is persisted.`,
    impactIfIgnored: 'The conflict can keep blocking the plan or create a same-day collision.',
    confidence: 0.86,
    whyFacts: conflictGraph,
    whyPreferences: input.preferredWindowLabel ? [`Preference considered: ${input.preferredWindowLabel}.`] : [],
    whyRules: ['Schedule and capacity conflicts must go through Secretary before user-facing action.'],
    whyTradeoffs: ['The recommended slot resolves the conflict with the smallest known schedule change.'],
    automationEligibility: 'ask_first',
  };
}

export function evaluateAutopilotPolicy(input: DecisionLogicInput, logic: DecisionLogicV2): {
  eligibility: AutomationEligibility;
  reason: string;
} {
  const hasRiskyAction = input.actions.some((action) => ['accept_reflow', 'choose_another_time', 'approve_script', 'request_rewrite', 'mark_paid', 'add_meal'].includes(action.id));
  if (hasRiskyAction) {
    return { eligibility: 'ask_first', reason: 'schedule, content, finance, cooking, and training changes require explicit user approval by default' };
  }
  if (input.type === 'sync_failure' && input.actions.some((action) => action.id === 'retry')) {
    return { eligibility: 'safe_auto_handle', reason: 'retrying a provider sync is reversible and does not mutate user plans by itself' };
  }
  if (logic.quality.status !== 'pass') {
    return { eligibility: 'safe_auto_handle', reason: 'incomplete decisions can be auto-hidden or re-enriched without changing user state' };
  }
  return { eligibility: 'never', reason: 'no safe autopilot rule applies' };
}

export function rankDecision(
  input: DecisionLogicInput,
  logic: Pick<DecisionLogicV2, 'confidence' | 'riskIfIgnored' | 'automationEligibility'>,
  quality?: DecisionQualityGateResult,
): DecisionRankResult {
  const urgency = input.priority === 'critical' ? 100
    : input.priority === 'time_sensitive' ? 90
      : input.priority === 'active' ? 65
        : 20;
  const deadline = input.deadlineAt ?? input.expiresAt ?? input.context?.deadlineAt ?? null;
  const deadlineBoost = deadlineSoon(deadline) ? 12 : 0;
  const riskBoost = logic.riskIfIgnored === 'high' ? 18 : logic.riskIfIgnored === 'medium' ? 8 : 0;
  const confidencePenalty = logic.confidence < 0.5 ? 15 : 0;
  const qualityPenalty = quality && !quality.safeToShowUser ? 40 : 0;
  const priorityScore = Math.max(0, urgency + deadlineBoost + riskBoost - confidencePenalty - qualityPenalty);
  const apnsEligible = (quality?.safeForAPNs ?? true) && priorityScore >= 82 && input.priority !== 'passive';
  return {
    priorityScore,
    homeVisible: priorityScore >= 55 && (quality?.safeForHomePreview ?? true),
    section: sectionForInput(input),
    apnsEligible,
    digestEligible: priorityScore < 55 || input.priority === 'passive',
    autoHandleEligible: logic.automationEligibility === 'safe_auto_handle',
    groupingKey: `${input.sourceSkill}:${input.type}:${input.relatedEntityType ?? 'none'}`,
  };
}

function recipeForInput(input: DecisionLogicInput): Omit<DecisionLogicV2, 'sourceSkill' | 'type' | 'privacyClassification' | 'visibilityScope' | 'notificationEligibility' | 'apnsInterruptionLevel' | 'collapseKey' | 'badgeContribution' | 'quality' | 'qualityScore'> {
  if (input.sourceSkill === 'secretary' || input.type === 'conflict_detected' || input.type === 'reflow_suggestion') {
    return secretaryRecipe(input);
  }
  if (input.sourceSkill === 'training') return trainingRecipe(input);
  if (input.sourceSkill === 'content' || input.type === 'approval_required') return contentRecipe(input);
  if (input.sourceSkill === 'finance') return financeRecipe(input);
  if (input.sourceSkill === 'cooking') return cookingRecipe(input);
  if (input.sourceSkill === 'chat') return chatRecipe(input);
  if (input.type === 'sync_failure') return syncFailureRecipe(input);
  return genericRecipe(input);
}

function secretaryRecipe(input: DecisionLogicInput): Omit<DecisionLogicV2, 'sourceSkill' | 'type' | 'privacyClassification' | 'visibilityScope' | 'notificationEligibility' | 'apnsInterruptionLevel' | 'collapseKey' | 'badgeContribution' | 'quality' | 'qualityScore'> {
  const context = input.context ?? {};
  const entityTitle = context.entityTitle?.trim() || null;
  const window = formatWindow(context.recommendedStartAt ?? context.currentStartAt, context.recommendedEndAt ?? context.currentEndAt);
  const hasConcreteAgenda = !!entityTitle && !!window;
  const primary = primaryAction(input.actions);
  const title = hasConcreteAgenda ? 'Schedule conflict' : sanitizeTitle(input.title);
  return {
    title,
    problemStatement: hasConcreteAgenda
      ? `${entityTitle} needs a schedule decision for ${window}.`
      : 'Secretary cannot show this schedule conflict until it has the affected item and candidate time.',
    recommendation: hasConcreteAgenda
      ? `Use the proposed ${window} slot or choose another feasible time.`
      : 'Keep the decision internal and ask Secretary to enrich the conflict details.',
    expectedEffect: hasConcreteAgenda
      ? 'Secretary will persist the selected schedule change, verify the agenda item, and close the decision only after read-back succeeds.'
      : 'No user-facing action should run until Secretary has a persisted agenda item.',
    impactIfIgnored: hasConcreteAgenda
      ? 'The conflict can keep blocking your plan or collide with another commitment.'
      : 'Showing this now would ask for judgment without enough context.',
    primaryActionLabel: concreteActionLabel(primary, hasConcreteAgenda ? 'Reflow' : 'Enrich details'),
    secondaryActionLabels: secondaryActionLabels(input.actions, primary),
    whySummary: hasConcreteAgenda
      ? `Secretary found a schedule/capacity issue and has a concrete ${window} recommendation.`
      : 'Secretary is missing the source agenda item required for a real recommendation.',
    urgencyReason: input.priority === 'time_sensitive' ? 'The decision affects a same-day or deadline-sensitive schedule item.' : 'The decision affects your schedule.',
    confidence: hasConcreteAgenda ? 0.86 : 0.34,
    relatedEntityReason: hasConcreteAgenda ? null : input.context?.explicitNoRelatedEntityReason ?? null,
    why: {
      facts: hasConcreteAgenda ? [`Affected item: ${entityTitle}.`, `Candidate window: ${window}.`] : ['No persisted Secretary agenda item was available.'],
      preferences: [],
      rules: ['Schedule, time, and capacity conflicts must be arbitrated by Secretary.'],
      tradeoffs: hasConcreteAgenda ? ['The proposed change is bounded to the affected item.'] : ['Hiding the card is safer than showing a vague decision.'],
      uncertainty: hasConcreteAgenda ? [] : ['The exact conflict and alternative slot are unknown.'],
    },
    whatWillChange: hasConcreteAgenda ? [{
      item: entityTitle,
      effect: `Move or confirm the agenda item at ${window}.`,
      targetSkill: 'secretary',
      verificationMethod: 'Read secretary_agenda_items after the action.',
    }] : [],
    readBackVerifier: hasConcreteAgenda ? 'secretary_agenda_item_state' : null,
    automationEligibility: 'ask_first',
    autopilotPolicy: 'Schedule changes ask first unless the user explicitly opts into automation.',
    safePreviewTitle: hasConcreteAgenda ? 'Schedule decision' : 'Decision details unavailable',
    safePreviewBody: hasConcreteAgenda ? 'Open Nexus to review a concrete schedule recommendation.' : 'Nexus is enriching this decision before showing it.',
    riskIfIgnored: hasConcreteAgenda ? 'high' : 'medium',
  };
}

function trainingRecipe(input: DecisionLogicInput): Omit<DecisionLogicV2, 'sourceSkill' | 'type' | 'privacyClassification' | 'visibilityScope' | 'notificationEligibility' | 'apnsInterruptionLevel' | 'collapseKey' | 'badgeContribution' | 'quality' | 'qualityScore'> {
  const isRaceDate = /race date/i.test(`${input.title} ${input.body} ${input.relatedEntityType ?? ''}`);
  return {
    title: isRaceDate ? 'Training plan needs race date' : 'Training decision',
    problemStatement: isRaceDate
      ? 'Your training plan is missing the race date needed for a race-specific build.'
      : 'Training needs your confirmation before it changes the plan.',
    recommendation: isRaceDate
      ? 'Add the race date, or choose continuous training if there is no target race yet.'
      : 'Review the training adjustment before Nexus changes load or schedule.',
    expectedEffect: isRaceDate
      ? 'Training can generate the correct build, peak, and taper phases after the race date is saved.'
      : 'Training updates only after the action is verified against the plan state.',
    impactIfIgnored: isRaceDate
      ? 'Nexus may keep the plan generic and avoid race-specific periodization.'
      : 'The training adjustment remains paused.',
    primaryActionLabel: isRaceDate ? 'Add race date' : concreteActionLabel(primaryAction(input.actions), 'Review training'),
    secondaryActionLabels: secondaryActionLabels(input.actions, primaryAction(input.actions)),
    whySummary: isRaceDate
      ? 'Race-specific training requires a target date before Nexus can safely phase the plan.'
      : 'Training changes can affect load and recovery, so Nexus asks before changing them.',
    urgencyReason: input.priority === 'time_sensitive' ? 'This blocks an imminent training plan update.' : 'This affects future training quality.',
    confidence: isRaceDate ? 0.9 : 0.72,
    relatedEntityReason: isRaceDate ? input.context?.explicitNoRelatedEntityReason ?? 'training profile is the affected entity' : null,
    why: {
      facts: isRaceDate ? ['No target race date is available for the plan.'] : ['Training emitted an action-gated adjustment.'],
      preferences: [],
      rules: ['Training load and plan changes should not be silently changed by default.'],
      tradeoffs: isRaceDate ? ['Continuous training is safer than inventing a target race.'] : ['Asking preserves control over fatigue-sensitive changes.'],
      uncertainty: [],
    },
    whatWillChange: [{
      item: isRaceDate ? 'Training profile' : 'Training plan',
      effect: isRaceDate ? 'Save race date or switch to continuous plan.' : 'Apply the confirmed training adjustment.',
      targetSkill: 'training',
      verificationMethod: isRaceDate ? 'Read the training profile after saving.' : 'Read the training plan after action.',
    }],
    readBackVerifier: input.actions.some((action) => MUTATING_ACTION_IDS.has(action.id)) ? 'training_state' : null,
    automationEligibility: 'ask_first',
    autopilotPolicy: 'Training load changes ask first.',
    safePreviewTitle: 'Training decision',
    safePreviewBody: isRaceDate ? 'Training needs one missing input.' : 'Open Nexus to review the training decision.',
    riskIfIgnored: isRaceDate ? 'medium' : 'high',
  };
}

function contentRecipe(input: DecisionLogicInput): Omit<DecisionLogicV2, 'sourceSkill' | 'type' | 'privacyClassification' | 'visibilityScope' | 'notificationEligibility' | 'apnsInterruptionLevel' | 'collapseKey' | 'badgeContribution' | 'quality' | 'qualityScore'> {
  const contentTitle = input.context?.entityTitle?.trim() || 'A content item';
  return {
    title: 'Content review',
    problemStatement: `${contentTitle} is ready for approval or rewrite feedback.`,
    recommendation: 'Approve it if it is ready, or request a rewrite with changes.',
    expectedEffect: 'Content workflow state changes to approved or rewrite-requested only after read-back verifies the draft.',
    impactIfIgnored: 'The content workflow remains paused and downstream publishing cannot proceed.',
    primaryActionLabel: concreteActionLabel(primaryAction(input.actions), 'Approve'),
    secondaryActionLabels: secondaryActionLabels(input.actions, primaryAction(input.actions)),
    whySummary: 'Content publishing requires explicit approval before Nexus moves it forward.',
    urgencyReason: input.deadlineAt ? 'The approval has a deadline.' : 'The workflow is waiting for review.',
    confidence: input.relatedEntityId ? 0.88 : 0.5,
    relatedEntityReason: input.relatedEntityId ? null : null,
    why: {
      facts: [`Workflow item: ${contentTitle}.`, input.context?.sourceState ? `Current state: ${input.context.sourceState}.` : 'Current state is awaiting approval.'],
      preferences: [],
      rules: ['Nexus does not publish or approve content without user approval.'],
      tradeoffs: ['Approving moves work forward; rewrite keeps quality control before publishing.'],
      uncertainty: [],
    },
    whatWillChange: [{
      item: contentTitle,
      effect: 'Update content approval state.',
      targetSkill: 'content',
      verificationMethod: 'Read content workflow object approval state after action.',
    }],
    readBackVerifier: 'content_workflow_object_approval_state',
    automationEligibility: 'ask_first',
    autopilotPolicy: 'Content publishing and approval ask first.',
    safePreviewTitle: 'Content review',
    safePreviewBody: 'A content item is waiting for approval.',
    riskIfIgnored: 'medium',
  };
}

function financeRecipe(input: DecisionLogicInput): Omit<DecisionLogicV2, 'sourceSkill' | 'type' | 'privacyClassification' | 'visibilityScope' | 'notificationEligibility' | 'apnsInterruptionLevel' | 'collapseKey' | 'badgeContribution' | 'quality' | 'qualityScore'> {
  return {
    title: 'Finance decision',
    problemStatement: 'A finance item needs confirmation before Nexus marks it complete.',
    recommendation: 'Confirm only if the payment or finance task is already handled.',
    expectedEffect: 'Finance state is updated and verified without exposing private amounts in previews.',
    impactIfIgnored: 'The finance reminder stays open and may continue to appear.',
    primaryActionLabel: concreteActionLabel(primaryAction(input.actions), 'Confirm'),
    secondaryActionLabels: secondaryActionLabels(input.actions, primaryAction(input.actions)),
    whySummary: 'Finance actions are privacy-sensitive and require explicit confirmation.',
    urgencyReason: input.priority === 'time_sensitive' ? 'The finance item is deadline-sensitive.' : 'The finance workflow is waiting for confirmation.',
    confidence: input.relatedEntityId ? 0.78 : 0.46,
    relatedEntityReason: input.relatedEntityId ? null : null,
    why: {
      facts: ['A finance workflow emitted an action-gated decision.'],
      preferences: [],
      rules: ['Finance actions never auto-complete by default.'],
      tradeoffs: ['Confirmation keeps private financial state accurate.'],
      uncertainty: input.relatedEntityId ? [] : ['The exact finance entity is missing.'],
    },
    whatWillChange: [{
      item: 'Finance item',
      effect: 'Mark the scoped finance item complete or paid.',
      targetSkill: 'finance',
      verificationMethod: 'Read finance state after action.',
    }],
    readBackVerifier: 'finance_state',
    automationEligibility: 'never',
    autopilotPolicy: 'Finance actions always ask first by default.',
    safePreviewTitle: 'Finance decision',
    safePreviewBody: 'Open Nexus to review a finance decision.',
    riskIfIgnored: 'high',
  };
}

function cookingRecipe(input: DecisionLogicInput): Omit<DecisionLogicV2, 'sourceSkill' | 'type' | 'privacyClassification' | 'visibilityScope' | 'notificationEligibility' | 'apnsInterruptionLevel' | 'collapseKey' | 'badgeContribution' | 'quality' | 'qualityScore'> {
  return {
    title: 'Cooking decision',
    problemStatement: 'A meal or fueling choice needs your confirmation before Nexus updates the plan.',
    recommendation: 'Choose the meal update only if it fits your current plan and preferences.',
    expectedEffect: 'Cooking updates the meal plan and verifies the saved meal slot.',
    impactIfIgnored: 'The meal plan remains unchanged.',
    primaryActionLabel: concreteActionLabel(primaryAction(input.actions), 'Add meal'),
    secondaryActionLabels: secondaryActionLabels(input.actions, primaryAction(input.actions)),
    whySummary: 'Cooking suggestions become decisions only when a real choice changes the plan.',
    urgencyReason: input.priority === 'time_sensitive' ? 'The meal choice affects today.' : 'The meal plan is waiting for confirmation.',
    confidence: input.relatedEntityId ? 0.74 : 0.48,
    relatedEntityReason: input.relatedEntityId ? null : null,
    why: {
      facts: ['Cooking emitted an action-gated meal decision.'],
      preferences: [],
      rules: ['Meal plan writes need a concrete date, meal type, and title.'],
      tradeoffs: ['Asking avoids silently changing food choices.'],
      uncertainty: input.relatedEntityId ? [] : ['The concrete meal slot is missing.'],
    },
    whatWillChange: [{
      item: 'Meal plan',
      effect: 'Add or update a meal slot.',
      targetSkill: 'cooking',
      verificationMethod: 'Read meal plan after action.',
    }],
    readBackVerifier: 'meal_plan_state',
    automationEligibility: 'ask_first',
    autopilotPolicy: 'Meal plan changes ask first unless the user opts into automation.',
    safePreviewTitle: 'Cooking decision',
    safePreviewBody: 'Open Nexus to review a meal choice.',
    riskIfIgnored: 'low',
  };
}

function chatRecipe(input: DecisionLogicInput): Omit<DecisionLogicV2, 'sourceSkill' | 'type' | 'privacyClassification' | 'visibilityScope' | 'notificationEligibility' | 'apnsInterruptionLevel' | 'collapseKey' | 'badgeContribution' | 'quality' | 'qualityScore'> {
  return {
    title: 'Nexus needs your choice',
    problemStatement: 'A chat action is ambiguous and needs your answer before Nexus continues.',
    recommendation: 'Choose the option that matches your intent.',
    expectedEffect: 'Nexus records the selected option and resumes the scoped workflow through Decision Center validation.',
    impactIfIgnored: 'The chat action remains paused.',
    primaryActionLabel: concreteActionLabel(primaryAction(input.actions), 'Choose option'),
    secondaryActionLabels: secondaryActionLabels(input.actions, primaryAction(input.actions)),
    whySummary: 'Chat cannot bypass Decision Center for ambiguous or mutating actions.',
    urgencyReason: 'The workflow is waiting for your answer.',
    confidence: input.relatedEntityId ? 0.82 : 0.42,
    relatedEntityReason: input.relatedEntityId ? null : null,
    why: {
      facts: ['A pending chat confirmation exists.'],
      preferences: [],
      rules: ['Ambiguous actions must be confirmed through deterministic Decision APIs.'],
      tradeoffs: ['Confirmation avoids taking the wrong action.'],
      uncertainty: input.relatedEntityId ? [] : ['The pending chat confirmation id is missing.'],
    },
    whatWillChange: [{
      item: 'Chat confirmation',
      effect: 'Record the selected option.',
      targetSkill: 'chat',
      verificationMethod: 'Read pending confirmation store after action.',
    }],
    readBackVerifier: 'chat_pending_confirmation_store',
    automationEligibility: 'ask_first',
    autopilotPolicy: 'Chat ambiguity asks first.',
    safePreviewTitle: 'Nexus needs your choice',
    safePreviewBody: 'Open Nexus to choose how to continue.',
    riskIfIgnored: 'medium',
  };
}

function syncFailureRecipe(input: DecisionLogicInput): Omit<DecisionLogicV2, 'sourceSkill' | 'type' | 'privacyClassification' | 'visibilityScope' | 'notificationEligibility' | 'apnsInterruptionLevel' | 'collapseKey' | 'badgeContribution' | 'quality' | 'qualityScore'> {
  const provider = input.context?.providerName ?? 'provider';
  return {
    title: 'Sync needs retry',
    problemStatement: `${provider} sync did not complete.`,
    recommendation: 'Retry the sync in the background and keep the decision visible only if retry fails.',
    expectedEffect: 'Nexus retries the provider sync and verifies the provider status.',
    impactIfIgnored: 'Recent provider data may stay stale.',
    primaryActionLabel: concreteActionLabel(primaryAction(input.actions), 'Retry sync'),
    secondaryActionLabels: secondaryActionLabels(input.actions, primaryAction(input.actions)),
    whySummary: 'Retrying a failed sync is safe and reversible.',
    urgencyReason: input.priority === 'time_sensitive' ? 'The sync affects current-day planning.' : 'The provider state is stale.',
    confidence: 0.78,
    relatedEntityReason: input.relatedEntityId ? null : 'sync failure can be scoped to provider state rather than one entity',
    why: {
      facts: [`Provider: ${provider}.`],
      preferences: [],
      rules: ['Provider retries can be auto-handled when no user data changes.'],
      tradeoffs: ['Retrying may recover data without interrupting the user.'],
      uncertainty: [],
    },
    whatWillChange: [{
      item: `${provider} connection`,
      effect: 'Retry sync.',
      targetSkill: input.sourceSkill,
      verificationMethod: 'Read provider sync status after retry.',
    }],
    readBackVerifier: 'provider_sync_state',
    automationEligibility: 'safe_auto_handle',
    autopilotPolicy: 'Safe sync retries may auto-handle and show history.',
    safePreviewTitle: 'Sync retry',
    safePreviewBody: 'Nexus is checking a provider sync.',
    riskIfIgnored: 'medium',
  };
}

function genericRecipe(input: DecisionLogicInput): Omit<DecisionLogicV2, 'sourceSkill' | 'type' | 'privacyClassification' | 'visibilityScope' | 'notificationEligibility' | 'apnsInterruptionLevel' | 'collapseKey' | 'badgeContribution' | 'quality' | 'qualityScore'> {
  return {
    title: sanitizeTitle(input.title),
    problemStatement: input.body,
    recommendation: 'Open the decision for details.',
    expectedEffect: 'Nexus will keep the decision open until a deterministic action is available.',
    impactIfIgnored: 'The item remains unresolved.',
    primaryActionLabel: concreteActionLabel(primaryAction(input.actions), 'Open'),
    secondaryActionLabels: secondaryActionLabels(input.actions, primaryAction(input.actions)),
    whySummary: 'This item needs user judgment before Nexus acts.',
    urgencyReason: input.priority === 'passive' ? 'Optional decision.' : 'Active decision.',
    confidence: 0.55,
    relatedEntityReason: input.relatedEntityId ? null : null,
    why: {
      facts: [input.body],
      preferences: [],
      rules: ['Decision Center requires concrete facts before showing user-facing cards.'],
      tradeoffs: [],
      uncertainty: [],
    },
    whatWillChange: [],
    readBackVerifier: input.actions.some((action) => MUTATING_ACTION_IDS.has(action.id)) ? null : null,
    automationEligibility: 'never',
    autopilotPolicy: 'No autopilot rule applies.',
    safePreviewTitle: sanitizeTitle(input.title),
    safePreviewBody: input.safeBody ?? input.body,
    riskIfIgnored: 'low',
  };
}

function isVisiblePushCandidate(input: DecisionLogicInput): boolean {
  if (input.priority === 'passive') return false;
  if (input.type === 'insight') return false;
  return input.priority === 'critical'
    || input.priority === 'time_sensitive'
    || deadlineSoon(input.deadlineAt ?? input.expiresAt ?? input.context?.deadlineAt ?? null)
    || input.type === 'conflict_detected'
    || input.type === 'approval_required'
    || input.type === 'security_account';
}

function sectionForInput(input: DecisionLogicInput): DecisionRankResult['section'] {
  if (input.type === 'conflict_detected' || input.type === 'reflow_suggestion') return 'schedule_conflicts';
  if (input.type === 'approval_required') return 'approvals';
  if (input.type === 'sync_failure') return 'waiting_on_systems';
  return 'needs_input';
}

function primaryAction(actions: NotificationActionButton[]): NotificationActionButton | null {
  return actions.find((action) => action.style === 'primary')
    ?? actions.find((action) => action.id !== 'open_detail')
    ?? actions[0]
    ?? null;
}

function secondaryActionLabels(actions: NotificationActionButton[], primary: NotificationActionButton | null): string[] {
  return actions
    .filter((action) => action.id !== primary?.id)
    .map((action) => concreteActionLabel(action, action.id === 'open_detail' ? 'Open details' : action.label))
    .filter((label) => !!label);
}

function concreteActionLabel(action: NotificationActionButton | null, fallback: string): string {
  if (!action) return fallback;
  if (isGenericCopy(action.label)) return fallback;
  return action.label;
}

function sanitizeTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Decision needed';
  if (isGenericCopy(trimmed)) return 'Decision details unavailable';
  return trimmed.length > 80 ? `${trimmed.slice(0, 79).trimEnd()}…` : trimmed;
}

function requireConcrete(value: string | null | undefined, field: string, missingFields: string[]): void {
  if (typeof value !== 'string' || !value.trim() || isGenericCopy(value)) {
    missingFields.push(field);
  }
}

function requirePresent(value: string | null | undefined, field: string, missingFields: string[]): void {
  if (typeof value !== 'string' || !value.trim()) {
    missingFields.push(field);
  }
}

function isGenericCopy(value: string | null | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim();
  if (!normalized) return true;
  return GENERIC_COPY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function formatWindow(startAt?: string | null, endAt?: string | null): string | null {
  if (!startAt || !endAt || !isValidWindow(startAt, endAt)) return null;
  return `${startAt} to ${endAt}`;
}

function isValidWindow(startAt?: string | null, endAt?: string | null): boolean {
  if (!startAt || !endAt) return false;
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  return Number.isFinite(start) && Number.isFinite(end) && start < end;
}

function deadlineSoon(deadline: string | null | undefined): boolean {
  if (!deadline) return false;
  const ms = Date.parse(deadline) - Date.now();
  return Number.isFinite(ms) && ms >= 0 && ms <= 24 * 3_600_000;
}
