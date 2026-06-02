// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DomainName } from '../domains/types';
import type { RouteResult } from '../router';
import type { ConversationContext } from '../router/classifier';

export type NexusSkillId =
  | 'secretary'
  | 'training'
  | 'cooking'
  | 'finance'
  | 'content'
  | 'shared_context'
  | 'tools';

export type ChatIntentKind =
  | 'information'
  | 'action'
  | 'scheduling'
  | 'plan_creation'
  | 'cancellation'
  | 'edit_update'
  | 'analysis'
  | 'cross_skill'
  | 'tenant_admin'
  | 'ambiguous'
  | 'correction'
  | 'prior_context'
  | 'explanation'
  | 'stale_context';

export interface ChatSkillRoutingDecision {
  primaryDomain: DomainName | null;
  involvedSkills: NexusSkillId[];
  intentKinds: ChatIntentKind[];
  confidence: number;
  reasonCodes: string[];
  explanation: string;
  ownership: {
    scheduleOwner: 'secretary';
    contentOwners: NexusSkillId[];
    chatRole: 'coordinate_and_explain';
  };
  safety: {
    destructive: boolean;
    requiresConfirmation: boolean;
    explicitConfirmation: boolean;
    confirmationReasonCodes: string[];
  };
  context: {
    shouldRefreshBeforeAnswer: boolean;
    staleContextRisk: boolean;
    ambiguousReference: boolean;
    tenantBoundaryMention: boolean;
  };
}

export interface ChatSkillRouteOverride {
  domain: string;
  confidence: number;
}

const SKILL_TO_DOMAIN: Partial<Record<NexusSkillId, DomainName>> = {
  secretary: 'secretary',
  training: 'triathlon',
  cooking: 'cooking',
  finance: 'finance',
  content: 'content',
};

const DOMAIN_TO_SKILL: Record<string, NexusSkillId> = {
  secretary: 'secretary',
  triathlon: 'training',
  cooking: 'cooking',
  finance: 'finance',
  content: 'content',
};

const V2_DOMAIN_TO_LEGACY_DOMAIN: Record<string, DomainName> = {
  secretary: 'secretary',
  training: 'triathlon',
  cooking: 'cooking',
  finance: 'finance',
  content: 'content',
};

const SKILL_PATTERNS: Array<{ skill: NexusSkillId; pattern: RegExp }> = [
  {
    skill: 'training',
    pattern: /\b(training|workouts?|gym|lift|strength|run(?:ning)?|ride|cycling|bike|recovery|session|deload|treino|corrida|pedal|muscula[cç][aã]o|recupera[cç][aã]o)\b/i,
  },
  {
    skill: 'cooking',
    pattern: /\b(cook(?:ing)?|meal|meal\s+prep|food|fuel(?:ing)?|recipe|grocery|groceries|shopping\s+list|lunch|dinner|breakfast|cozin|refei[cç][aã]o|mercado|compras)\b/i,
  },
  {
    skill: 'finance',
    pattern: /\b(finance|budget|afford|bill|invoice|tax|subscription|expense|purchase|payment|money|cash|conta|or[cç]amento|fatura|imposto|assinatura|comprar)\b/i,
  },
  {
    skill: 'content',
    pattern: /\b(content|script|post|publish|publishing|video|film(?:ing)?|edit(?:ing)?|campaign|creator|thumbnail|hook|roteiro|conte[uú]do|publicar|grava[cç][aã]o|edi[cç][aã]o)\b/i,
  },
  {
    skill: 'secretary',
    pattern: /\b(schedule|calendar|agenda|meeting|task|reminder|follow[- ]?up|daily\s+plan|weekly\s+plan|plan\s+my\s+(?:day|week)|move|reschedule|defer|fit|find\s+time|availability|today|tomorrow|agenda|calend[aá]rio|reuni[aã]o|lembrete|prioriza|organiza|encaixa)\b/i,
  },
];

const SCHEDULING_PATTERNS = [
  /\b(plan\s+my\s+(?:day|week)|plan\s+(?:the\s+)?week|schedule|calendar|agenda|find\s+time|fit\s+(?:it|this|that|time)|make\s+time|time[- ]?block|block\s+time|move|reschedule|reflow|defer|push|shift|clear\s+(?:my\s+)?calendar)\b/i,
  /\b(prioriti[sz]e\s+(?:my\s+)?(?:day|week)|what\s+do\s+i\s+need\s+to\s+do\s+today|what\s+should\s+i\s+do\s+today|what\s+changed\s+since\s+yesterday)\b/i,
  /\b(agenda|marca|remarca|reagenda|planeia|planejar|organiza|encaixa|arranja\s+tempo|prioriza|muda\s+(?:isso|isto)|move\s+(?:isso|isto))\b/i,
];

const ACTION_PATTERNS = [
  /\b(create|add|make|build|generate|schedule|move|reschedule|cancel|delete|remove|eliminate|clear|send|reply|mark|update|change|apply|save|remember)\b/i,
  /\b(cria|crie|adiciona|faz|gera|agenda|move|muda|remarca|cancela|cancelar|cancele|cancelem|apaga|apagar|apague|apaguem|remove|remover|remova|removam|elimina|eliminar|elimine|eliminem|exclui|excluir|exclua|excluam|limpa|envia|responde|marca|atualiza|aplica|guarda|lembra)\b/i,
];

const DESTRUCTIVE_PATTERNS = [
  /\b(cancel|delete|remove|eliminate|clear|wipe|discard|send\s+(?:the\s+)?email|reply\s+to|mark\s+.*\s+paid|cancel\s+my\s+plan|clear\s+(?:the\s+)?calendar)\b/i,
  /\b(cancela|cancelar|cancele|cancelem|apaga|apagar|apague|apaguem|remove|remover|remova|removam|elimina|eliminar|elimine|eliminem|exclui|excluir|exclua|excluam|limpa|descarta|envia\s+(?:o\s+)?email|responde|marca\s+.*\s+pago)\b/i,
];

const EXPLANATION_PATTERNS = [/\b(why|explain|what\s+are\s+you\s+basing|based\s+on\s+what|por\s+qu[eê]|explica|baseaste)\b/i];
const CORRECTION_PATTERNS = [/\b(actually|i\s+changed\s+my\s+mind|not\s+that|instead|i\s+meant|correction|na\s+verdade|mudei\s+de\s+ideia|queria\s+dizer)\b/i];
const PRIOR_CONTEXT_PATTERNS = [/\b(that|it|this|same|same\s+as|last\s+week|yesterday|we\s+just|normal|usual|isso|isto|aquilo|mesmo|ontem|semana\s+passada)\b/i];
const STALE_CONTEXT_PATTERNS = [/\b(current|latest|now|today|since\s+yesterday|changed\s+since|still|refresh|stale|atual|agora|hoje|desde\s+ontem|mudou)\b/i];
const TENANT_PATTERNS = [/\b(other\s+tenant|another\s+tenant|other\s+workspace|different\s+workspace|tenant\s+admin|workspace\s+admin|outro\s+tenant|outra\s+empresa|outro\s+workspace)\b/i];
const EXPLICIT_CONFIRMATION_PATTERNS = [
  /\b(confirm(?:ed)?|i\s+confirm|go\s+ahead\s+and|proceed\s+with|yes,\s*(?:cancel|delete|remove|clear|send|reply|mark)|do\s+it:\s*)\b/i,
  /\b(confirmo|podes\s+(?:cancelar|apagar|remover|limpar|enviar)|sim,\s*(?:cancela|apaga|remove|limpa|envia|responde))\b/i,
];

export function analyzeChatSkillOrchestration(input: {
  message: string;
  activeContext?: ConversationContext | null;
  routedDomain?: DomainName | null;
  userId?: number | null;
  tenantId?: number | null;
}): ChatSkillRoutingDecision {
  const message = input.message.trim();
  const involved = resolveInvolvedSkills(message, input.activeContext, input.routedDomain);
  const intentKinds = resolveIntentKinds(message, involved);
  const destructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(message));
  const explicitConfirmation = destructive && EXPLICIT_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(message));
  const scheduling = intentKinds.includes('scheduling');
  const tenantBoundaryMention = TENANT_PATTERNS.some((pattern) => pattern.test(message));
  const staleContextRisk = STALE_CONTEXT_PATTERNS.some((pattern) => pattern.test(message));
  const ambiguousReference = PRIOR_CONTEXT_PATTERNS.some((pattern) => pattern.test(message))
    && message.split(/\s+/).length <= 16;
  const crossSkill = involved.filter((skill) => skill !== 'shared_context' && skill !== 'tools').length > 1;
  let primaryDomain = resolvePrimaryDomain({ message, involved, scheduling, routedDomain: input.routedDomain });
  const reasonCodes = buildReasonCodes({ scheduling, crossSkill, destructive, staleContextRisk, ambiguousReference, tenantBoundaryMention });

  if (tenantBoundaryMention) {
    reasonCodes.push('tenant_boundary_requires_confirmation');
  }

  if (!primaryDomain && input.routedDomain) {
    primaryDomain = input.routedDomain;
  }

  return {
    primaryDomain,
    involvedSkills: involved,
    intentKinds: crossSkill && !intentKinds.includes('cross_skill') ? [...intentKinds, 'cross_skill'] : intentKinds,
    confidence: resolveConfidence({ scheduling, crossSkill, destructive, ambiguousReference, primaryDomain }),
    reasonCodes,
    explanation: buildExplanation(primaryDomain, involved, intentKinds),
    ownership: {
      scheduleOwner: 'secretary',
      contentOwners: involved.filter((skill) => skill !== 'secretary' && skill !== 'shared_context' && skill !== 'tools'),
      chatRole: 'coordinate_and_explain',
    },
    safety: {
      destructive,
      requiresConfirmation: destructive && !isHowToQuestion(message),
      explicitConfirmation,
      confirmationReasonCodes: destructive
        ? ['destructive_or_external_side_effect', explicitConfirmation ? 'explicit_confirmation_present' : 'explicit_confirmation_missing']
        : [],
    },
    context: {
      shouldRefreshBeforeAnswer: staleContextRisk || scheduling || crossSkill,
      staleContextRisk,
      ambiguousReference,
      tenantBoundaryMention,
    },
  };
}

export function applyChatSkillRoutingDecision(
  route: RouteResult,
  decision: ChatSkillRoutingDecision,
  routeOverride?: ChatSkillRouteOverride | null,
): RouteResult {
  if (routeOverride) {
    const mappedDomain = V2_DOMAIN_TO_LEGACY_DOMAIN[routeOverride.domain];
    if (mappedDomain && mappedDomain !== route.domain) {
      return {
        ...route,
        domain: mappedDomain,
        method: 'context',
        confidence: Math.max(route.confidence, routeOverride.confidence),
      };
    }
  }

  if (!decision.primaryDomain || decision.primaryDomain === route.domain) {
    return route;
  }

  const canOverride = decision.confidence >= 0.86 && (
    decision.intentKinds.includes('scheduling')
    || decision.intentKinds.includes('cross_skill')
    || decision.reasonCodes.includes('skill_ownership_override')
  );

  if (!canOverride) return route;

  return {
    ...route,
    domain: decision.primaryDomain,
    method: 'context',
    confidence: Math.max(route.confidence, decision.confidence),
  };
}

export function buildChatSkillRoutingPromptBlock(decision: ChatSkillRoutingDecision): string {
  const lines: string[] = [];
  lines.push(`<chat_skill_routing primary_domain="${decision.primaryDomain ?? 'none'}" confidence="${decision.confidence.toFixed(2)}">`);
  lines.push(`<intent kinds="${decision.intentKinds.join(',')}" involved_skills="${decision.involvedSkills.join(',')}" reason_codes="${decision.reasonCodes.join(',')}" />`);
  lines.push('<ownership_rules>');
  lines.push('- Chat coordinates and explains. Do not bypass the skill that owns the data or action.');
  lines.push('- Secretary owns agenda placement, scheduling, rescheduling, reminders, and cross-skill time arbitration.');
  lines.push('- Training owns training content and coaching-plan changes.');
  lines.push('- Cooking owns meals, recipes, grocery lists, meal prep, and fueling content.');
  lines.push('- Finance owns financial analysis, budgets, bills, subscriptions, and purchase constraints.');
  lines.push('- Content owns content workflows, references, scripts, publishing cadence, and content ideas.');
  lines.push('</ownership_rules>');
  if (decision.safety.requiresConfirmation) {
    lines.push(`<action_safety destructive="true" explicit_confirmation="${decision.safety.explicitConfirmation}" reason_codes="${decision.safety.confirmationReasonCodes.join(',')}">`);
    lines.push('Do not perform destructive or external side-effect actions unless server-side authorization confirms this turn has explicit user confirmation.');
    lines.push('</action_safety>');
  }
  if (decision.context.shouldRefreshBeforeAnswer) {
    lines.push(`<context_refresh stale_risk="${decision.context.staleContextRisk}" ambiguous_reference="${decision.context.ambiguousReference}" tenant_boundary="${decision.context.tenantBoundaryMention}" />`);
  }
  lines.push(`Explanation: ${decision.explanation}`);
  lines.push('</chat_skill_routing>');
  return lines.join('\n');
}

export function buildChatSkillRoutingLogContext(decision: ChatSkillRoutingDecision): Record<string, unknown> {
  return {
    primaryDomain: decision.primaryDomain,
    involvedSkills: decision.involvedSkills,
    intentKinds: decision.intentKinds,
    confidence: decision.confidence,
    reasonCodes: decision.reasonCodes,
    destructive: decision.safety.destructive,
    requiresConfirmation: decision.safety.requiresConfirmation,
    explicitConfirmation: decision.safety.explicitConfirmation,
    shouldRefreshBeforeAnswer: decision.context.shouldRefreshBeforeAnswer,
  };
}

function resolveInvolvedSkills(
  message: string,
  activeContext?: ConversationContext | null,
  routedDomain?: DomainName | null,
): NexusSkillId[] {
  const skills = new Set<NexusSkillId>();
  for (const { skill, pattern } of SKILL_PATTERNS) {
    if (pattern.test(message)) skills.add(skill);
  }
  if (activeContext?.domain && DOMAIN_TO_SKILL[activeContext.domain]) {
    skills.add(DOMAIN_TO_SKILL[activeContext.domain]);
  }
  if (routedDomain && DOMAIN_TO_SKILL[routedDomain]) {
    skills.add(DOMAIN_TO_SKILL[routedDomain]);
  }
  if (/\b(memory|remember|shared\s+context|context|normal|usual|preference)\b/i.test(message)) {
    skills.add('shared_context');
  }
  if (skills.size === 0) skills.add('secretary');
  return [...skills];
}

function resolveIntentKinds(message: string, involved: NexusSkillId[]): ChatIntentKind[] {
  const kinds = new Set<ChatIntentKind>();
  const hasAction = ACTION_PATTERNS.some((pattern) => pattern.test(message));
  const hasScheduling = SCHEDULING_PATTERNS.some((pattern) => pattern.test(message));
  if (hasAction) kinds.add('action');
  else kinds.add('information');
  if (hasScheduling) kinds.add('scheduling');
  if (/\b(create|build|generate|make)\b[\s\S]{0,40}\b(plan|training\s+plan|meal\s+plan|content\s+plan)\b/i.test(message)) {
    kinds.add('plan_creation');
  }
  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(message))) kinds.add('cancellation');
  if (/\b(update|change|move|reschedule|edit|adjust|muda|altera|remarca|ajusta)\b/i.test(message)) kinds.add('edit_update');
  if (/\b(analy[sz]e|review|compare|can\s+i\s+afford|what\s+changed|what\s+do\s+i\s+need|analisa|rev[eê])\b/i.test(message)) kinds.add('analysis');
  if (involved.length > 1) kinds.add('cross_skill');
  if (TENANT_PATTERNS.some((pattern) => pattern.test(message))) kinds.add('tenant_admin');
  if (CORRECTION_PATTERNS.some((pattern) => pattern.test(message))) kinds.add('correction');
  if (PRIOR_CONTEXT_PATTERNS.some((pattern) => pattern.test(message))) kinds.add('prior_context');
  if (EXPLANATION_PATTERNS.some((pattern) => pattern.test(message))) kinds.add('explanation');
  if (STALE_CONTEXT_PATTERNS.some((pattern) => pattern.test(message))) kinds.add('stale_context');
  if (message.split(/\s+/).length <= 3 && kinds.size <= 1) kinds.add('ambiguous');
  return [...kinds];
}

function resolvePrimaryDomain(input: {
  message: string;
  involved: NexusSkillId[];
  scheduling: boolean;
  routedDomain?: DomainName | null;
}): DomainName | null {
  const text = input.message;
  if (input.scheduling && isGuidanceQuestion(text) && /\b(filming|recording|editing|publish(?:ing)?|video|content|grava[cç][aã]o|filmagem|edi[cç][aã]o|conte[uú]do)\b/i.test(text)) {
    return 'content';
  }
  if (input.scheduling) {
    return 'secretary';
  }
  if (/\b(task|tasks|to-?do|calendar|meeting|event|reminder|email|inbox|agenda|tarefa|tarefas|calend[aá]rio|reuni[aã]o|evento|lembrete|e-?mail)\b/i.test(text)) {
    return 'secretary';
  }
  if (/\b(content\s+ideas?|script|caption|hook|thumbnail|publish|video\s+ideas?|roteiro|ideias?\s+de\s+conte[uú]do)\b/i.test(text)) {
    return 'content';
  }
  if (/\b(can\s+i\s+afford|budget|invoice|tax|expense|subscription|or[cç]amento|fatura|imposto)\b/i.test(text)) {
    return 'finance';
  }
  if (/\b(recipe|meal\s+plan|what\s+should\s+i\s+eat|grocery|cooking|receita|refei[cç][aã]o|lista\s+de\s+compras)\b/i.test(text)) {
    return 'cooking';
  }
  if (/\b(training\s+plan|workout\s+plan|what\s+workout|how\s+should\s+i\s+train|treino|plano\s+de\s+treino)\b/i.test(text)) {
    return 'triathlon';
  }
  for (const skill of input.involved) {
    const domain = SKILL_TO_DOMAIN[skill];
    if (domain) return domain;
  }
  return input.routedDomain ?? null;
}

function resolveConfidence(input: {
  scheduling: boolean;
  crossSkill: boolean;
  destructive: boolean;
  ambiguousReference: boolean;
  primaryDomain: DomainName | null;
}): number {
  if (!input.primaryDomain) return 0.4;
  if (input.scheduling && input.crossSkill) return 0.96;
  if (input.scheduling) return 0.92;
  if (input.destructive) return 0.9;
  if (input.ambiguousReference) return 0.72;
  return 0.84;
}

function buildReasonCodes(input: {
  scheduling: boolean;
  crossSkill: boolean;
  destructive: boolean;
  staleContextRisk: boolean;
  ambiguousReference: boolean;
  tenantBoundaryMention: boolean;
}): string[] {
  const codes: string[] = [];
  if (input.scheduling) codes.push('secretary_owns_schedule_placement', 'skill_ownership_override');
  if (input.crossSkill) codes.push('multi_skill_orchestration');
  if (input.destructive) codes.push('destructive_action_safety');
  if (input.staleContextRisk) codes.push('refresh_current_state_before_answer');
  if (input.ambiguousReference) codes.push('resolve_prior_context_before_action');
  if (input.tenantBoundaryMention) codes.push('tenant_scope_sensitive');
  if (codes.length === 0) codes.push('single_skill_standard_route');
  return codes;
}

function buildExplanation(primaryDomain: DomainName | null, involved: NexusSkillId[], intents: ChatIntentKind[]): string {
  const primary = primaryDomain ?? 'unknown';
  if (primary === 'secretary' && intents.includes('scheduling')) {
    return `Routed to Secretary because schedule placement and cross-skill time arbitration belong to Secretary. Involved skills: ${involved.join(', ')}.`;
  }
  return `Routed to ${primary} with Chat coordinating context and response composition. Involved skills: ${involved.join(', ')}.`;
}

function isHowToQuestion(message: string): boolean {
  return /\b(how\s+do\s+i|how\s+can\s+i|how\s+should\s+i|what\s+is\s+the\s+process|como\s+(?:eu\s+)?posso|como\s+devo|como\s+fa[cç]o)\b/i.test(message);
}

function isGuidanceQuestion(message: string): boolean {
  return /\b(how\s+should\s+i|how\s+would\s+you|what\s+is\s+the\s+best\s+way|what\s+should\s+i\s+consider|como\s+devo|qual\s+(?:é|e)\s+a\s+melhor\s+forma)\b/i.test(message);
}
