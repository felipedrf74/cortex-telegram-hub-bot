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
export type DecisionFrontendDisplayMode = 'needs_input' | 'handled' | 'waiting_on_system' | 'failed' | 'details_unavailable';
// Reserved for iOS offline/stale-cache handling; the server currently returns
// persisted-state disables only and should not infer device connectivity.
export type DecisionFrontendActionState = 'enabled' | 'disabled_missing_details' | 'disabled_expired' | 'disabled_superseded' | 'disabled_offline_requires_refresh';

export interface DecisionLogicContext {
  entityTitle?: string | null;
  currentStartAt?: string | null;
  currentEndAt?: string | null;
  recommendedStartAt?: string | null;
  recommendedEndAt?: string | null;
  candidateSlots?: Array<{ startAt: string; endAt: string; label?: string | null }> | null;
  reasonCodes?: string[] | null;
  sourceState?: string | null;
  explicitNoRelatedEntityReason?: string | null;
  providerName?: string | null;
  deadlineAt?: string | null;
  timezone?: string | null;
  locale?: string | null;
  visibilityScope?: DecisionVisibilityScope | null;
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
  safeForFrontendAction: boolean;
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
  displayMode: DecisionFrontendDisplayMode;
  frontendActionState: DecisionFrontendActionState;
  quality: DecisionQualityGateResult;
}

type DecisionLogicRecipe = Omit<DecisionLogicV2,
  'sourceSkill'
  | 'type'
  | 'privacyClassification'
  | 'visibilityScope'
  | 'notificationEligibility'
  | 'apnsInterruptionLevel'
  | 'collapseKey'
  | 'badgeContribution'
  | 'quality'
  | 'qualityScore'
  | 'displayMode'
  | 'frontendActionState'
>;

export interface SecretaryDecisionAdvisorInput {
  title: string;
  currentStartAt?: string | null;
  currentEndAt?: string | null;
  availableSlots?: Array<{ startAt: string; endAt: string; label?: string }>;
  preferredWindowLabel?: string | null;
  reasonCodes?: string[];
  timezone?: string | null;
  locale?: string | null;
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
  recommendedStartAt: string | null;
  recommendedEndAt: string | null;
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
  'choose_priority',
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
  /^decision details unavailable$/i,
  /^open nexus to view details/i,
  /^this item needs a decision before nexus acts/i,
  /\bneeds (?:your )?attention\b/i,
  /\bneeds your decision\b/i,
  /\bopen nexus to view\b/i,
];

const DECISION_CONFIDENCE_RUBRIC = {
  highStructuredState: 0.9,
  highEntityReadBack: 0.88,
  highScheduleRecommendation: 0.86,
  highChatConfirmation: 0.82,
  highSyncRetry: 0.78,
  mediumFinanceEntity: 0.78,
  mediumCookingEntity: 0.74,
  mediumTrainingReview: 0.72,
  mediumOvercapacityPriority: 0.76,
  mediumOwnerAdminOps: 0.7,
  mediumGenericDecision: 0.55,
  lowContentMissingEntity: 0.5,
  lowCookingMissingEntity: 0.48,
  lowFinanceMissingEntity: 0.46,
  lowChatMissingEntity: 0.42,
  lowAdvisorMissingContext: 0.38,
  lowMissingScheduleContext: 0.34,
} as const;

const DECISION_QUALITY_REQUIRED_FIELD_COUNT = 17;
const decisionWindowFormatterCache = new Map<string, Intl.DateTimeFormat>();

export function isDecisionLogicV2Enabled(): boolean {
  const value = process.env.DECISION_CENTER_LOGIC_V2_ENABLED;
  if (value == null || value.trim() === '') return true;
  return !['0', 'false', 'off', 'disabled', 'no'].includes(value.trim().toLowerCase());
}

export function buildDecisionLogicV2(input: DecisionLogicInput): DecisionLogicV2 {
  if (!isDecisionLogicV2Enabled()) {
    return buildLegacyDecisionLogic(input);
  }
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
    displayMode: quality.safeToShowUser ? 'needs_input' : 'details_unavailable',
    frontendActionState: quality.safeForFrontendAction ? 'enabled' : 'disabled_missing_details',
    quality,
  };
}

function buildLegacyDecisionLogic(input: DecisionLogicInput): DecisionLogicV2 {
  const primary = primaryAction(input.actions);
  const title = sanitizeTitle(input.title);
  const body = input.body?.trim() || input.safeBody?.trim() || title;
  const recipe: DecisionLogicRecipe = {
    title,
    problemStatement: body,
    recommendation: 'Open the decision for details.',
    expectedEffect: 'Nexus keeps the decision open until you choose an action.',
    impactIfIgnored: 'The item remains unresolved.',
    primaryActionLabel: concreteActionLabel(primary, 'Open'),
    secondaryActionLabels: secondaryActionLabels(input.actions, primary),
    whySummary: 'Decision Center is running in legacy compatibility mode.',
    urgencyReason: input.priority === 'passive' ? 'Optional decision.' : 'Active decision.',
    confidence: DECISION_CONFIDENCE_RUBRIC.mediumGenericDecision,
    relatedEntityReason: input.relatedEntityId ? null : input.context?.explicitNoRelatedEntityReason ?? 'legacy compatibility mode allows missing related entity',
    why: {
      facts: [body],
      preferences: [],
      rules: ['Decision Center Logic v2 quality enforcement is disabled by operator flag.'],
      tradeoffs: ['This is a rollback mode; APNs visible delivery stays disabled for safety.'],
      uncertainty: [],
    },
    whatWillChange: [],
    readBackVerifier: null,
    automationEligibility: 'never',
    autopilotPolicy: 'Legacy compatibility mode disables autopilot.',
    safePreviewTitle: safePreviewTitleForLegacy(input, title),
    safePreviewBody: safePreviewBodyForLegacy(input, body),
    riskIfIgnored: input.priority === 'critical' || input.priority === 'time_sensitive' ? 'high' : 'medium',
  };
  const quality: DecisionQualityGateResult = {
    status: 'pass',
    missingFields: [],
    qualityScore: 100,
    reason: 'Decision Center Logic v2 is disabled; returning legacy-compatible decision fields',
    safeToShowUser: true,
    safeForHomePreview: true,
    safeForAPNs: false,
    safeForFrontendAction: !!primary,
  };
  return {
    ...recipe,
    qualityScore: quality.qualityScore,
    sourceSkill: input.sourceSkill,
    type: input.type,
    privacyClassification: input.privacyClassification,
    visibilityScope: input.visibilityScope ?? input.context?.visibilityScope ?? 'user_private',
    notificationEligibility: 'digest',
    apnsInterruptionLevel: 'active',
    badgeContribution: false,
    collapseKey: null,
    displayMode: 'needs_input',
    frontendActionState: primary ? 'enabled' : 'disabled_missing_details',
    quality,
  };
}

export function evaluateDecisionQuality(
  input: DecisionLogicInput,
  recipe: DecisionLogicRecipe,
): DecisionQualityGateResult {
  const missingFields: string[] = [];
  const primary = primaryAction(input.actions);
  const mutating = input.actions.some(isMutatingAction);

  requireConcrete(recipe.title, 'title', missingFields);
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
  if (requiresSecretaryRecommendation(input) && !hasDistinctSecretaryRecommendation(input.context)) {
    missingFields.push('secretaryRecommendation');
  }

  const filled = DECISION_QUALITY_REQUIRED_FIELD_COUNT - missingFields.length;
  const score = Math.max(0, Math.min(100, Math.round((filled / DECISION_QUALITY_REQUIRED_FIELD_COUNT) * 100)));
  const status: DecisionQualityStatus = missingFields.length === 0
    ? 'pass'
    : missingFields.includes('concreteCopy')
      || missingFields.includes('relatedEntity')
      || missingFields.includes('readBackVerifier')
      || missingFields.includes('secretaryRecommendation')
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
    safeForFrontendAction: status === 'pass' && !!primary && (!mutating || !!recipe.readBackVerifier),
  };
}

export function adviseSecretaryDecision(input: SecretaryDecisionAdvisorInput): SecretaryDecisionAdvice {
  const current = formatDecisionWindow(input.currentStartAt, input.currentEndAt, input.timezone, input.locale);
  const feasibleSlots = (input.availableSlots ?? [])
    .filter((slot) => isValidWindow(slot.startAt, slot.endAt))
    .filter((slot) => !sameWindow(slot.startAt, slot.endAt, input.currentStartAt, input.currentEndAt));
  const best = feasibleSlots[0] ?? null;
  const title = input.title.trim() || 'schedule item';
  const bestWindow = best ? formatDecisionWindow(best.startAt, best.endAt, input.timezone, input.locale) : null;
  const conflictGraph = [
    current ? `${title} currently affects ${current}.` : `${title} is missing a concrete current schedule window.`,
    bestWindow ? `A feasible alternative exists at ${bestWindow}.` : 'No feasible alternative slot was supplied.',
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
      confidence: DECISION_CONFIDENCE_RUBRIC.lowAdvisorMissingContext,
      recommendedStartAt: null,
      recommendedEndAt: null,
      whyFacts: conflictGraph,
      whyPreferences: input.preferredWindowLabel ? [`Preference considered: ${input.preferredWindowLabel}.`] : [],
      whyRules: ['Secretary must not recommend impossible slots.'],
      whyTradeoffs: ['Waiting for availability is safer than showing a vague decision.'],
      automationEligibility: 'never',
    };
  }

  return {
    bestAction: `Use ${bestWindow}.`,
    alternatives: feasibleSlots.slice(1, 4).map((slot) => ({
      label: slot.label ?? formatDecisionWindow(slot.startAt, slot.endAt, input.timezone, input.locale) ?? 'Alternative slot',
      startAt: slot.startAt,
      endAt: slot.endAt,
      tradeoff: 'Alternative slot is feasible but lower priority than the recommended window.',
    })),
    feasibility: 'feasible',
    conflictGraph,
    capacityImpact: input.reasonCodes?.includes('overcapacity')
      ? 'Reduces pressure on an over-capacity window.'
      : 'Keeps the schedule change bounded to the affected item.',
    scheduleImpact: `Updates the affected schedule item to ${bestWindow}.`,
    expectedEffect: `Secretary reflows the item and verifies the new window is persisted.`,
    impactIfIgnored: 'The conflict can keep blocking the plan or create a same-day collision.',
    confidence: DECISION_CONFIDENCE_RUBRIC.highScheduleRecommendation,
    recommendedStartAt: best.startAt,
    recommendedEndAt: best.endAt,
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
  const hasRiskyAction = input.actions.some((action) => ['accept_reflow', 'choose_another_time', 'choose_priority', 'approve_script', 'request_rewrite', 'mark_paid', 'add_meal'].includes(action.id));
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
  const safeForAPNs = quality?.safeForAPNs ?? false;
  const safeForHomePreview = quality?.safeForHomePreview ?? false;
  const apnsEligible = safeForAPNs && priorityScore >= 82 && input.priority !== 'passive';
  return {
    priorityScore,
    homeVisible: priorityScore >= 55 && safeForHomePreview,
    section: sectionForInput(input),
    apnsEligible,
    digestEligible: priorityScore < 55 || input.priority === 'passive',
    autoHandleEligible: logic.automationEligibility === 'safe_auto_handle',
    groupingKey: `${input.sourceSkill}:${input.type}:${input.relatedEntityType ?? 'none'}`,
  };
}

function recipeForInput(input: DecisionLogicInput): DecisionLogicRecipe {
  if (input.type === 'sync_failure') return syncFailureRecipe(input);
  if (isOwnerAdminDecision(input)) return ownerAdminOpsRecipe(input);
  if (isOvercapacityDecision(input)) return overcapacityRecipe(input);
  if (input.sourceSkill === 'secretary' || input.type === 'conflict_detected' || input.type === 'reflow_suggestion') {
    return secretaryRecipe(input);
  }
  if (input.sourceSkill === 'training') return trainingRecipe(input);
  if (input.sourceSkill === 'content' || input.type === 'approval_required') return contentRecipe(input);
  if (input.sourceSkill === 'finance') return financeRecipe(input);
  if (input.sourceSkill === 'cooking') return cookingRecipe(input);
  if (input.sourceSkill === 'chat') return chatRecipe(input);
  return genericRecipe(input);
}

function overcapacityRecipe(input: DecisionLogicInput): DecisionLogicRecipe {
  const pt = isPortugueseDecision(input);
  const contextLabel = input.context?.entityTitle?.trim() || 'This schedule window';
  const primary = primaryAction(input.actions);
  const hasMutatingChoice = input.actions.some(isMutatingAction);
  return {
    title: pt ? 'Decisão de capacidade' : 'Overcapacity decision',
    problemStatement: pt
      ? `${contextLabel} está acima da capacidade e precisa de uma escolha de prioridade antes de o Nexus reorganizar algo.`
      : `${contextLabel} is over capacity and needs a priority choice before Nexus reflows anything.`,
    recommendation: pt
      ? 'Escolha o compromisso que o Nexus deve proteger primeiro; depois a Secretary reorganiza apenas itens de menor prioridade.'
      : 'Choose the commitment Nexus should protect first, then let Secretary reflow only lower-priority items.',
    expectedEffect: pt
      ? 'A Secretary registra a prioridade, atualiza o plano afetado e verifica o estado persistido da agenda antes de fechar a decisão.'
      : 'Secretary records the priority choice, updates the affected schedule plan, and verifies the persisted agenda state before closing the decision.',
    impactIfIgnored: pt
      ? 'O Nexus deixa a janela sem alteração, mantendo trabalho de menor prioridade empilhado contra compromissos mais importantes.'
      : 'Nexus leaves the window unchanged, which can keep lower-priority work stacked against higher-priority commitments.',
    primaryActionLabel: concreteActionLabel(primary, pt ? 'Escolher prioridade' : 'Choose priority'),
    secondaryActionLabels: secondaryActionLabels(input.actions, primary),
    whySummary: pt
      ? 'A Secretary encontrou mais trabalho do que a janela comporta com segurança; o Nexus precisa do seu julgamento antes de mudar o plano.'
      : 'Secretary found more work than the window can safely hold, so Nexus needs your priority judgment before changing the plan.',
    urgencyReason: input.priority === 'time_sensitive'
      ? (pt ? 'A sobrecarga afeta hoje ou um prazo próximo.' : 'The overcapacity affects today or a near deadline.')
      : (pt ? 'A sobrecarga afeta a qualidade da agenda próxima.' : 'The overcapacity affects upcoming schedule quality.'),
    confidence: DECISION_CONFIDENCE_RUBRIC.mediumOvercapacityPriority,
    relatedEntityReason: null,
    why: {
      facts: pt ? [`Janela afetada: ${contextLabel}.`, 'Pelo menos uma regra de capacidade marcou esta janela como sobrecarregada.'] : [`Affected window: ${contextLabel}.`, 'At least one capacity rule marked this window as overloaded.'],
      preferences: [],
      rules: [pt ? 'Conflitos de capacidade passam pela Secretary, e escolhas de prioridade perguntam ao usuário antes de reorganizar.' : 'Capacity conflicts must go through Secretary, and priority choices ask the user before reflow.'],
      tradeoffs: [pt ? 'Proteger um compromisso pode mover ou atrasar trabalho de menor prioridade.' : 'Protecting one commitment may move or delay lower-priority work.'],
      uncertainty: [],
    },
    whatWillChange: [{
      item: contextLabel,
      effect: pt ? 'Aplicar a prioridade selecionada e reorganizar apenas itens de menor prioridade.' : 'Apply the selected priority and reflow only lower-priority schedule items.',
      targetSkill: 'secretary',
      verificationMethod: pt ? 'Ler o estado da agenda da Secretary após a escolha de prioridade.' : 'Read secretary agenda state after the priority choice.',
    }],
    readBackVerifier: hasMutatingChoice ? 'secretary_agenda_item_state' : null,
    automationEligibility: 'ask_first',
    autopilotPolicy: pt ? 'Decisões de prioridade perguntam primeiro; o Nexus não escolhe prioridades do usuário em silêncio.' : 'Overcapacity priority decisions ask first; Nexus does not silently choose user priorities.',
    safePreviewTitle: pt ? 'Decisão de capacidade' : 'Overcapacity decision',
    safePreviewBody: pt ? 'Abra o Nexus para escolher o que deve ficar protegido.' : 'Open Nexus to choose what should stay protected.',
    riskIfIgnored: 'high',
  };
}

function ownerAdminOpsRecipe(input: DecisionLogicInput): DecisionLogicRecipe {
  const pt = isPortugueseDecision(input);
  const target = input.context?.entityTitle?.trim() || 'An operational system item';
  const primary = primaryAction(input.actions);
  return {
    title: pt ? 'Decisão operacional do proprietário' : 'Owner operations decision',
    problemStatement: pt ? `${target} precisa de revisão do proprietário antes de o Nexus alterar o comportamento do sistema.` : `${target} needs owner review before Nexus changes system behavior.`,
    recommendation: pt ? 'Revise a evidência operacional e aprove apenas pelo fluxo de proprietário/admin se a ação ainda for válida.' : 'Review the operational evidence and approve only through the owner/admin flow if the action is still valid.',
    expectedEffect: pt ? 'O Nexus registra a decisão de proprietário/admin e mantém produção inalterada até uma ação autorizada ser verificada.' : 'Nexus records the owner/admin decision and leaves production behavior unchanged until an authorized action is verified.',
    impactIfIgnored: pt ? 'O item operacional fica aberto e nenhuma mudança arriscada de sistema é aplicada automaticamente.' : 'The operational item stays open and no risky system change is applied automatically.',
    primaryActionLabel: concreteActionLabel(primary, pt ? 'Revisar decisão operacional' : 'Review ops decision'),
    secondaryActionLabels: secondaryActionLabels(input.actions, primary),
    whySummary: pt ? 'Decisões operacionais de proprietário/admin ficam fora dos cartões normais de usuário e exigem revisão explícita.' : 'Owner/admin operational decisions are scoped away from normal user cards and require explicit review.',
    urgencyReason: input.priority === 'critical' || input.priority === 'time_sensitive'
      ? (pt ? 'O problema operacional pode afetar confiabilidade ou segurança de release em breve.' : 'The operational issue can affect reliability or release safety soon.')
      : (pt ? 'O problema operacional exige atenção do proprietário antes da ação.' : 'The operational issue requires owner attention before action.'),
    confidence: DECISION_CONFIDENCE_RUBRIC.mediumOwnerAdminOps,
    relatedEntityReason: null,
    why: {
      facts: [pt ? `Item operacional: ${target}.` : `Operational item: ${target}.`],
      preferences: [],
      rules: pt ? ['Decisões de system-admin não devem aparecer como decisões normais de usuário.', 'O Nexus não aplica mudanças operacionais de proprietário/admin automaticamente por padrão.'] : ['System-admin decisions must not be shown as normal user decisions.', 'Nexus cannot auto-apply owner/admin operational changes by default.'],
      tradeoffs: [pt ? 'Manter isto explícito evita mudanças ocultas em produção ou release.' : 'Keeping this explicit avoids hidden production or release changes.'],
      uncertainty: [],
    },
    whatWillChange: [{
      item: target,
      effect: pt ? 'Registrar revisão de proprietário/admin; qualquer mudança seguinte deve usar executor verificado próprio.' : 'Record owner/admin review; any mutating follow-up must use its own verified executor.',
      targetSkill: input.sourceSkill,
      verificationMethod: pt ? 'Ler estado operacional ou log de auditoria após a ação.' : 'Read owner/admin operation state or audit log after action.',
    }],
    readBackVerifier: null,
    automationEligibility: 'never',
    autopilotPolicy: pt ? 'Decisões operacionais de proprietário/admin nunca são tratadas automaticamente por padrão.' : 'Owner/admin operational decisions never auto-handle by default.',
    safePreviewTitle: pt ? 'Revisão do proprietário necessária' : 'Owner review needed',
    safePreviewBody: pt ? 'Abra o Nexus para revisar uma decisão operacional.' : 'Open Nexus to review an operational decision.',
    riskIfIgnored: input.priority === 'critical' || input.priority === 'time_sensitive' ? 'high' : 'medium',
  };
}

function secretaryRecipe(input: DecisionLogicInput): DecisionLogicRecipe {
  const pt = isPortugueseDecision(input);
  const context = input.context ?? {};
  const entityTitle = context.entityTitle?.trim() || null;
  const currentWindow = formatDecisionWindow(context.currentStartAt, context.currentEndAt, context.timezone, context.locale);
  const recommendedWindow = formatDecisionWindow(context.recommendedStartAt, context.recommendedEndAt, context.timezone, context.locale);
  const hasConcreteAgenda = !!entityTitle && !!recommendedWindow;
  const primary = primaryAction(input.actions);
  const title = hasConcreteAgenda ? 'Schedule conflict' : sanitizeTitle(input.title);
  return {
    title: hasConcreteAgenda ? (pt ? 'Conflito de agenda' : title) : title,
    problemStatement: hasConcreteAgenda
      ? (pt ? `${entityTitle} precisa de uma decisão de agenda${currentWindow ? ` de ${currentWindow}` : ''} para ${recommendedWindow}.` : `${entityTitle} needs a schedule decision${currentWindow ? ` from ${currentWindow}` : ''} to ${recommendedWindow}.`)
      : (pt ? 'A Secretary não pode mostrar este conflito até ter o item afetado e o horário candidato.' : 'Secretary cannot show this schedule conflict until it has the affected item and candidate time.'),
    recommendation: hasConcreteAgenda
      ? (pt ? `Use ${recommendedWindow} ou escolha outro horário viável.` : `Use ${recommendedWindow} or choose another feasible time.`)
      : (pt ? 'Mantenha a decisão interna e peça para a Secretary enriquecer os detalhes do conflito.' : 'Keep the decision internal and ask Secretary to enrich the conflict details.'),
    expectedEffect: hasConcreteAgenda
      ? (pt ? 'A Secretary persistirá a mudança de agenda selecionada, verificará o item e fechará a decisão apenas após read-back bem-sucedido.' : 'Secretary will persist the selected schedule change, verify the agenda item, and close the decision only after read-back succeeds.')
      : (pt ? 'Nenhuma ação para o usuário deve rodar até a Secretary ter um item de agenda persistido.' : 'No user-facing action should run until Secretary has a persisted agenda item.'),
    impactIfIgnored: hasConcreteAgenda
      ? (pt ? 'O conflito pode continuar bloqueando seu plano ou colidir com outro compromisso.' : 'The conflict can keep blocking your plan or collide with another commitment.')
      : (pt ? 'Mostrar isto agora pediria julgamento sem contexto suficiente.' : 'Showing this now would ask for judgment without enough context.'),
    primaryActionLabel: concreteActionLabel(primary, hasConcreteAgenda ? (pt ? 'Reorganizar' : 'Reflow') : (pt ? 'Enriquecer detalhes' : 'Enrich details')),
    secondaryActionLabels: secondaryActionLabels(input.actions, primary),
    whySummary: hasConcreteAgenda
      ? (pt ? `A Secretary encontrou um problema de agenda/capacidade e tem uma recomendação concreta para ${recommendedWindow}.` : `Secretary found a schedule/capacity issue and has a concrete ${recommendedWindow} recommendation.`)
      : (pt ? 'A Secretary está sem o item de agenda de origem necessário para uma recomendação real.' : 'Secretary is missing the source agenda item required for a real recommendation.'),
    urgencyReason: input.priority === 'time_sensitive'
      ? (pt ? 'A decisão afeta um item de agenda de hoje ou sensível a prazo.' : 'The decision affects a same-day or deadline-sensitive schedule item.')
      : (pt ? 'A decisão afeta sua agenda.' : 'The decision affects your schedule.'),
    confidence: hasConcreteAgenda ? DECISION_CONFIDENCE_RUBRIC.highScheduleRecommendation : DECISION_CONFIDENCE_RUBRIC.lowMissingScheduleContext,
    relatedEntityReason: hasConcreteAgenda ? null : input.context?.explicitNoRelatedEntityReason ?? null,
    why: {
      facts: hasConcreteAgenda ? (pt ? [`Item afetado: ${entityTitle}.`, `Janela candidata: ${recommendedWindow}.`] : [`Affected item: ${entityTitle}.`, `Candidate window: ${recommendedWindow}.`]) : [pt ? 'Nenhum item de agenda persistido da Secretary estava disponível.' : 'No persisted Secretary agenda item was available.'],
      preferences: [],
      rules: [pt ? 'Conflitos de agenda, tempo e capacidade devem ser arbitrados pela Secretary.' : 'Schedule, time, and capacity conflicts must be arbitrated by Secretary.'],
      tradeoffs: hasConcreteAgenda ? [pt ? 'A mudança proposta fica limitada ao item afetado.' : 'The proposed change is bounded to the affected item.'] : [pt ? 'Ocultar o cartão é mais seguro do que mostrar uma decisão vaga.' : 'Hiding the card is safer than showing a vague decision.'],
      uncertainty: hasConcreteAgenda ? [] : [pt ? 'O conflito exato e o horário alternativo são desconhecidos.' : 'The exact conflict and alternative slot are unknown.'],
    },
    whatWillChange: hasConcreteAgenda ? [{
      item: entityTitle,
      effect: pt ? `Mover ou confirmar o item de agenda em ${recommendedWindow}.` : `Move or confirm the agenda item at ${recommendedWindow}.`,
      targetSkill: 'secretary',
      verificationMethod: pt ? 'Ler secretary_agenda_items após a ação.' : 'Read secretary_agenda_items after the action.',
    }] : [],
    readBackVerifier: hasConcreteAgenda ? 'secretary_agenda_item_state' : null,
    automationEligibility: 'ask_first',
    autopilotPolicy: pt ? 'Mudanças de agenda perguntam primeiro, salvo opt-in explícito para automação.' : 'Schedule changes ask first unless the user explicitly opts into automation.',
    safePreviewTitle: hasConcreteAgenda ? (pt ? 'Decisão de agenda' : 'Schedule decision') : (pt ? 'Detalhes da decisão indisponíveis' : 'Decision details unavailable'),
    safePreviewBody: hasConcreteAgenda ? (pt ? 'Abra o Nexus para revisar uma recomendação concreta de agenda.' : 'Open Nexus to review a concrete schedule recommendation.') : (pt ? 'O Nexus está enriquecendo esta decisão antes de mostrá-la.' : 'Nexus is enriching this decision before showing it.'),
    riskIfIgnored: hasConcreteAgenda ? 'high' : 'medium',
  };
}

function trainingRecipe(input: DecisionLogicInput): DecisionLogicRecipe {
  const pt = isPortugueseDecision(input);
  const isRaceDate = /race date/i.test(`${input.title} ${input.body} ${input.relatedEntityType ?? ''}`);
  return {
    title: isRaceDate ? (pt ? 'Plano de treino precisa da data da prova' : 'Training plan needs race date') : (pt ? 'Decisão de treino' : 'Training decision'),
    problemStatement: isRaceDate
      ? (pt ? 'Seu plano de treino não tem a data da prova necessária para uma preparação específica.' : 'Your training plan is missing the race date needed for a race-specific build.')
      : (pt ? 'O treino precisa da sua confirmação antes de alterar o plano.' : 'Training needs your confirmation before it changes the plan.'),
    recommendation: isRaceDate
      ? (pt ? 'Adicione a data da prova ou escolha treino contínuo se ainda não houver prova-alvo.' : 'Add the race date, or choose continuous training if there is no target race yet.')
      : (pt ? 'Revise o ajuste de treino antes de o Nexus mudar carga ou agenda.' : 'Review the training adjustment before Nexus changes load or schedule.'),
    expectedEffect: isRaceDate
      ? (pt ? 'O Treino pode gerar as fases corretas de construção, pico e polimento após salvar a data da prova.' : 'Training can generate the correct build, peak, and taper phases after the race date is saved.')
      : (pt ? 'O Treino atualiza apenas após a ação ser verificada contra o estado do plano.' : 'Training updates only after the action is verified against the plan state.'),
    impactIfIgnored: isRaceDate
      ? (pt ? 'O Nexus pode manter o plano genérico e evitar periodização específica da prova.' : 'Nexus may keep the plan generic and avoid race-specific periodization.')
      : (pt ? 'O ajuste de treino permanece pausado.' : 'The training adjustment remains paused.'),
    primaryActionLabel: isRaceDate ? (pt ? 'Adicionar data da prova' : 'Add race date') : concreteActionLabel(primaryAction(input.actions), pt ? 'Revisar treino' : 'Review training'),
    secondaryActionLabels: secondaryActionLabels(input.actions, primaryAction(input.actions)),
    whySummary: isRaceDate
      ? (pt ? 'Treino específico para prova exige uma data-alvo antes de o Nexus fasear o plano com segurança.' : 'Race-specific training requires a target date before Nexus can safely phase the plan.')
      : (pt ? 'Mudanças de treino podem afetar carga e recuperação, então o Nexus pergunta antes de alterar.' : 'Training changes can affect load and recovery, so Nexus asks before changing them.'),
    urgencyReason: input.priority === 'time_sensitive' ? (pt ? 'Isto bloqueia uma atualização iminente do plano de treino.' : 'This blocks an imminent training plan update.') : (pt ? 'Isto afeta a qualidade futura do treino.' : 'This affects future training quality.'),
    confidence: isRaceDate ? DECISION_CONFIDENCE_RUBRIC.highStructuredState : DECISION_CONFIDENCE_RUBRIC.mediumTrainingReview,
    relatedEntityReason: isRaceDate ? input.context?.explicitNoRelatedEntityReason ?? 'training profile is the affected entity' : null,
    why: {
      facts: isRaceDate ? [pt ? 'Nenhuma data-alvo de prova está disponível para o plano.' : 'No target race date is available for the plan.'] : [pt ? 'O Treino emitiu um ajuste que exige ação.' : 'Training emitted an action-gated adjustment.'],
      preferences: [],
      rules: [pt ? 'Carga e plano de treino não devem ser alterados silenciosamente por padrão.' : 'Training load and plan changes should not be silently changed by default.'],
      tradeoffs: isRaceDate ? [pt ? 'Treino contínuo é mais seguro do que inventar uma prova-alvo.' : 'Continuous training is safer than inventing a target race.'] : [pt ? 'Perguntar preserva controle sobre mudanças sensíveis à fadiga.' : 'Asking preserves control over fatigue-sensitive changes.'],
      uncertainty: [],
    },
    whatWillChange: [{
      item: isRaceDate ? 'Training profile' : 'Training plan',
      effect: isRaceDate ? (pt ? 'Salvar data da prova ou mudar para plano contínuo.' : 'Save race date or switch to continuous plan.') : (pt ? 'Aplicar o ajuste de treino confirmado.' : 'Apply the confirmed training adjustment.'),
      targetSkill: 'training',
      verificationMethod: isRaceDate ? (pt ? 'Ler o perfil de treino após salvar.' : 'Read the training profile after saving.') : (pt ? 'Ler o plano de treino após a ação.' : 'Read the training plan after action.'),
    }],
    readBackVerifier: input.actions.some(isMutatingAction) ? 'training_state' : null,
    automationEligibility: 'ask_first',
    autopilotPolicy: pt ? 'Mudanças de carga de treino perguntam primeiro.' : 'Training load changes ask first.',
    safePreviewTitle: pt ? 'Decisão de treino' : 'Training decision',
    safePreviewBody: isRaceDate ? (pt ? 'O Treino precisa de uma informação faltante.' : 'Training needs one missing input.') : (pt ? 'Abra o Nexus para revisar a decisão de treino.' : 'Open Nexus to review the training decision.'),
    riskIfIgnored: isRaceDate ? 'medium' : 'high',
  };
}

function contentRecipe(input: DecisionLogicInput): DecisionLogicRecipe {
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
    confidence: input.relatedEntityId ? DECISION_CONFIDENCE_RUBRIC.highEntityReadBack : DECISION_CONFIDENCE_RUBRIC.lowContentMissingEntity,
    relatedEntityReason: null,
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

function financeRecipe(input: DecisionLogicInput): DecisionLogicRecipe {
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
    confidence: input.relatedEntityId ? DECISION_CONFIDENCE_RUBRIC.mediumFinanceEntity : DECISION_CONFIDENCE_RUBRIC.lowFinanceMissingEntity,
    relatedEntityReason: null,
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

function cookingRecipe(input: DecisionLogicInput): DecisionLogicRecipe {
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
    confidence: input.relatedEntityId ? DECISION_CONFIDENCE_RUBRIC.mediumCookingEntity : DECISION_CONFIDENCE_RUBRIC.lowCookingMissingEntity,
    relatedEntityReason: null,
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

function chatRecipe(input: DecisionLogicInput): DecisionLogicRecipe {
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
    confidence: input.relatedEntityId ? DECISION_CONFIDENCE_RUBRIC.highChatConfirmation : DECISION_CONFIDENCE_RUBRIC.lowChatMissingEntity,
    relatedEntityReason: null,
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

function syncFailureRecipe(input: DecisionLogicInput): DecisionLogicRecipe {
  const pt = isPortugueseDecision(input);
  const provider = input.context?.providerName ?? 'provider';
  return {
    title: pt ? 'Sincronização precisa de nova tentativa' : 'Sync needs retry',
    problemStatement: pt ? `A sincronização de ${provider} não foi concluída.` : `${provider} sync did not complete.`,
    recommendation: pt ? 'Tente sincronizar em segundo plano e mantenha a decisão visível apenas se a nova tentativa falhar.' : 'Retry the sync in the background and keep the decision visible only if retry fails.',
    expectedEffect: pt ? 'O Nexus tenta sincronizar o provedor e verifica o status do provedor.' : 'Nexus retries the provider sync and verifies the provider status.',
    impactIfIgnored: pt ? 'Dados recentes do provedor podem continuar desatualizados.' : 'Recent provider data may stay stale.',
    primaryActionLabel: concreteActionLabel(primaryAction(input.actions), pt ? 'Tentar sincronizar' : 'Retry sync'),
    secondaryActionLabels: secondaryActionLabels(input.actions, primaryAction(input.actions)),
    whySummary: pt ? 'Tentar novamente uma sincronização com falha é seguro e reversível.' : 'Retrying a failed sync is safe and reversible.',
    urgencyReason: input.priority === 'time_sensitive' ? (pt ? 'A sincronização afeta o planejamento do dia atual.' : 'The sync affects current-day planning.') : (pt ? 'O estado do provedor está desatualizado.' : 'The provider state is stale.'),
    confidence: DECISION_CONFIDENCE_RUBRIC.highSyncRetry,
    relatedEntityReason: input.relatedEntityId ? null : 'sync failure can be scoped to provider state rather than one entity',
    why: {
      facts: [pt ? `Provedor: ${provider}.` : `Provider: ${provider}.`],
      preferences: [],
      rules: [pt ? 'Novas tentativas de provedor podem ser tratadas automaticamente quando não alteram dados do usuário.' : 'Provider retries can be auto-handled when no user data changes.'],
      tradeoffs: [pt ? 'Tentar novamente pode recuperar dados sem interromper o usuário.' : 'Retrying may recover data without interrupting the user.'],
      uncertainty: [],
    },
    whatWillChange: [{
      item: `${provider} connection`,
      effect: pt ? 'Tentar sincronizar novamente.' : 'Retry sync.',
      targetSkill: input.sourceSkill,
      verificationMethod: pt ? 'Ler o status de sincronização após a nova tentativa.' : 'Read provider sync status after retry.',
    }],
    readBackVerifier: 'provider_sync_state',
    automationEligibility: 'safe_auto_handle',
    autopilotPolicy: pt ? 'Novas tentativas seguras podem ser tratadas automaticamente e aparecer no histórico.' : 'Safe sync retries may auto-handle and show history.',
    safePreviewTitle: pt ? 'Nova tentativa de sincronização' : 'Sync retry',
    safePreviewBody: pt ? 'O Nexus está verificando uma sincronização de provedor.' : 'Nexus is checking a provider sync.',
    riskIfIgnored: 'medium',
  };
}

function genericRecipe(input: DecisionLogicInput): DecisionLogicRecipe {
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
    confidence: DECISION_CONFIDENCE_RUBRIC.mediumGenericDecision,
    relatedEntityReason: null,
    why: {
      facts: [input.body],
      preferences: [],
      rules: ['Decision Center requires concrete facts before showing user-facing cards.'],
      tradeoffs: [],
      uncertainty: [],
    },
    whatWillChange: [],
    readBackVerifier: null,
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
  if (isOwnerAdminDecision(input)) return 'needs_input';
  if (isOvercapacityDecision(input)) return 'schedule_conflicts';
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

function isMutatingAction(action: NotificationActionButton): boolean {
  return action.mutating === true || MUTATING_ACTION_IDS.has(action.id);
}

function requiresSecretaryRecommendation(input: DecisionLogicInput): boolean {
  if (input.type === 'sync_failure') return false;
  if (isOvercapacityDecision(input)) return false;
  return input.sourceSkill === 'secretary'
    || input.type === 'conflict_detected'
    || input.type === 'reflow_suggestion';
}

function isOvercapacityDecision(input: DecisionLogicInput): boolean {
  return input.sourceSkill === 'secretary'
    && (input.context?.reasonCodes ?? []).includes('overcapacity');
}

function isOwnerAdminDecision(input: DecisionLogicInput): boolean {
  const visibilityScope = input.visibilityScope ?? input.context?.visibilityScope;
  return visibilityScope === 'system_admin'
    || (input.sourceSkill === 'system' && input.type === 'risk_warning' && input.relatedEntityType?.includes('ops'))
    || (input.sourceSkill === 'security' && input.type === 'security_account' && visibilityScope === 'tenant_admin');
}

function hasDistinctSecretaryRecommendation(context: DecisionLogicContext | null | undefined): boolean {
  if (!context?.recommendedStartAt || !context.recommendedEndAt) return false;
  if (!isValidWindow(context.recommendedStartAt, context.recommendedEndAt)) return false;
  return !sameWindow(
    context.recommendedStartAt,
    context.recommendedEndAt,
    context.currentStartAt,
    context.currentEndAt,
  );
}

function sanitizeTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Decision needed';
  if (isGenericCopy(trimmed)) return 'Decision details unavailable';
  return trimmed.length > 80 ? `${trimmed.slice(0, 79).trimEnd()}…` : trimmed;
}

function isPortugueseDecision(input: DecisionLogicInput): boolean {
  return normalizeDecisionLocale(input.context?.locale).toLowerCase().startsWith('pt');
}

function safePreviewTitleForLegacy(input: DecisionLogicInput, fallbackTitle: string): string {
  if (input.privacyClassification === 'financial' || input.sourceSkill === 'finance') return 'Finance decision';
  if (input.privacyClassification === 'health' || input.sourceSkill === 'training') return 'Training decision';
  if (input.privacyClassification === 'private_content' || input.sourceSkill === 'content') return 'Content review';
  if (input.privacyClassification === 'sensitive') return input.sourceSkill === 'security' ? 'Security decision' : 'Decision needed';
  return fallbackTitle;
}

function safePreviewBodyForLegacy(input: DecisionLogicInput, fallbackBody: string): string {
  if (input.privacyClassification === 'financial'
    || input.privacyClassification === 'health'
    || input.privacyClassification === 'private_content'
    || input.privacyClassification === 'sensitive') {
    return 'Open Nexus to review this decision.';
  }
  return input.safeBody?.trim() || fallbackBody;
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

export function formatDecisionWindow(
  startAt?: string | null,
  endAt?: string | null,
  timezone?: string | null,
  locale?: string | null,
): string | null {
  if (!startAt || !endAt || !isValidWindow(startAt, endAt)) return null;
  const zone = normalizeDecisionTimezone(timezone);
  const normalizedLocale = normalizeDecisionLocale(locale);
  const start = new Date(startAt);
  const end = new Date(endAt);
  const dateFormatter = decisionWindowFormatter(normalizedLocale, zone, 'date');
  const timeFormatter = decisionWindowFormatter(normalizedLocale, zone, 'time');
  const startDate = dateFormatter.format(start);
  const endDate = dateFormatter.format(end);
  const startTime = timeFormatter.format(start);
  const endTime = timeFormatter.format(end);
  if (startDate === endDate) return `${startDate}, ${startTime}-${endTime}`;
  const joiner = normalizedLocale.toLowerCase().startsWith('pt') ? 'a' : 'to';
  return `${startDate}, ${startTime} ${joiner} ${endDate}, ${endTime}`;
}

function decisionWindowFormatter(locale: string, timeZone: string, kind: 'date' | 'time'): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${kind}`;
  const cached = decisionWindowFormatterCache.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale, kind === 'date'
    ? { timeZone, weekday: 'short', month: 'short', day: 'numeric' }
    : { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  decisionWindowFormatterCache.set(key, formatter);
  return formatter;
}

function normalizeDecisionTimezone(timezone?: string | null): string {
  const candidate = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

function normalizeDecisionLocale(locale?: string | null): string {
  const candidate = typeof locale === 'string' && locale.trim() ? locale.trim() : 'en-US';
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([candidate])[0] ?? 'en-US';
  } catch {
    return 'en-US';
  }
}

function isValidWindow(startAt?: string | null, endAt?: string | null): boolean {
  if (!startAt || !endAt) return false;
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  return Number.isFinite(start) && Number.isFinite(end) && start < end;
}

function sameWindow(
  startAt?: string | null,
  endAt?: string | null,
  otherStartAt?: string | null,
  otherEndAt?: string | null,
): boolean {
  if (!startAt || !endAt || !otherStartAt || !otherEndAt) return false;
  return Date.parse(startAt) === Date.parse(otherStartAt) && Date.parse(endAt) === Date.parse(otherEndAt);
}

function deadlineSoon(deadline: string | null | undefined): boolean {
  if (!deadline) return false;
  const ms = Date.parse(deadline) - Date.now();
  return Number.isFinite(ms) && ms >= 0 && ms <= 24 * 3_600_000;
}
