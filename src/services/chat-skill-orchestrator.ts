// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DomainName } from '../domains/types';
import type { RouteResult } from '../router';
import type { ConversationContext } from '../router/classifier';
import { isManifestRoutingEnabled } from './intent-resolution/manifest-routing-flags';
import { manifestDomainMatches } from './intent-resolution/manifest-projections';
import { resolveIntent } from './intent-resolution/intent-resolver';
import {
  calibrateIntentResolverScore,
  getClarifyPolicy,
  getOrchestratorBranchConfidence,
  getOrchestratorOverrideThreshold,
  isRoutingClarifyEnabled,
} from './intent-resolution/confidence';
import {
  buildRoutingClarifyQuestion,
  isRoutingClarifyQuestion,
} from './chat/planner/clarification';
import { recordRoutingClarifyDecision } from './chat-hybrid-metrics';

// ─── M12 manifest convergence (flag: AI_ROUTING_MANIFEST_ORCHESTRATOR) ─
//
// MISROUTE-FIX CONVENTION (flag on): fix a misroute with ONE manifest
// vocabulary edit (config/capability-manifest.json routingVocabulary) plus ONE
// corpus fixture — never by adding a new inline regex to this file. The inline
// SKILL_PATTERNS below remain the flag-OFF legacy path only.
//
// Flag-on scope (deliberate): SKILL_PATTERNS (domain vocabulary) become
// projections of the compiled manifest vocabulary. SCHEDULING_PATTERNS,
// ACTION/DESTRUCTIVE/EXPLANATION/etc. remain code-owned INTENT-KIND policy
// matchers — the manifest's axis is capability/domain vocabulary and has no
// intent-kind dimension, so projecting scheduling from it would collapse
// "any secretary term" into "scheduling intent" and break routing parity.
// The >=0.86 override semantics and all thresholds are unchanged (M14 owns
// thresholds).

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

/**
 * M14 — deterministic clarify decision (flag AI_ROUTING_CLARIFY, default
 * OFF). Emitted when the top-2 calibrated manifest candidates are within
 * epsilon and the turn is an actionable WRITE. Reads never clarify.
 */
export interface ChatRoutingClarifyDecision {
  question: string;
  candidateDomains: [DomainName, DomainName];
  calibratedScores: [number, number];
  reason: 'ambiguous_write_intents';
}

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
  /** Always null when AI_ROUTING_CLARIFY is off (the default). */
  clarify: ChatRoutingClarifyDecision | null;
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

// M15: manifest chatActionSkill → orchestrator skill vocabulary. The
// classifier's skill hint lives in the manifest action-skill space
// (secretary_calendar, mail, tasks, …); the orchestrator reasons in
// NexusSkillId space. Action skills without an orchestrator counterpart
// (connections, notifications, decision_center) are deliberately unmapped —
// the hint is ignored for them (their routing is domain-level only).
const CLASSIFIER_ACTION_SKILL_TO_ORCHESTRATOR_SKILL: Record<string, NexusSkillId> = {
  secretary_calendar: 'secretary',
  secretary_reminders: 'secretary',
  mail: 'secretary',
  tasks: 'secretary',
  training: 'training',
  content: 'content',
  cooking: 'cooking',
  finance: 'finance',
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
    // Codex QA round 8: added `receipt`/`recibo`/`transaction`/`despesa`/`gasto`
    // so "Log this receipt for 45 EUR..." is recognized as a finance
    // half of a split-intent. Without these, the orchestrator missed
    // the finance side of "Log this receipt and remind me Friday".
    pattern: /\b(finance|budget|afford|bill|invoice|receipts?|tax|subscription|expense|purchase|payment|transaction|money|cash|conta|or[cç]amento|fatura|recibos?|imposto|assinatura|comprar|despesas?|gastos?)\b/i,
  },
  {
    skill: 'content',
    pattern: /\b(content|script|post|publish|publishing|video|film(?:ing)?|edit(?:ing)?|campaign|creator|thumbnail|hook|roteiro|conte[uú]do|publicar|grava[cç][aã]o|edi[cç][aã]o)\b/i,
  },
  {
    skill: 'secretary',
    // Codex QA round 8: added explicit `remind me|set a reminder|
    // lembra-me|me lembra` phrasings so reminder intents in a split-
    // intent message ("...and remind me Friday") count toward the
    // secretary skill. Without these, the secretary half of
    // "Log this receipt and remind me Friday" was invisible.
    pattern: /\b(schedule|calendar|agenda|meeting|task|reminder|remind\s+me|set\s+(?:a\s+)?reminder|lembra-?me|me\s+lembra|me\s+lembre|follow[- ]?up|daily\s+plan|weekly\s+plan|plan\s+my\s+(?:day|week)|move|reschedule|defer|fit|find\s+time|availability|today|tomorrow|agenda|calend[aá]rio|reuni[aã]o|lembrete|prioriza|organiza|encaixa)\b/i,
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
  /**
   * M14: BCP-47-ish locale for the templated clarify question (EN/PT/ES).
   * Optional and additive — callers that do not pass it get EN templates.
   */
  locale?: string | null;
  /**
   * M14: increment the clarify budget counters for this evaluation.
   * ONLY the /message pipeline's deciding call (the pre_routing stage) passes
   * true — exactly once per pipeline turn. Every other caller (legacy-tail
   * routed overlay, WebSocket, context engine, day-to-day simulation,
   * routing-accuracy replays, divergence shadow) must leave it unset so
   * offline/duplicate evaluations can never skew the ≤10% budget telemetry.
   */
  countClarifyTelemetry?: boolean;
  /**
   * M15 (flag AI_CLASSIFY_MANIFEST_PROMPT): manifest-validated
   * chatActionSkill hint from the classifier ({domain, skill, confidence}
   * output shape). Consumed as an OWNERSHIP hint only: when present and it
   * maps to an orchestrator skill, that skill joins involvedSkills and a
   * reason code records the hint. Absent (the flag-off default) → byte
   * identical behavior.
   */
  classifierSkillHint?: string | null;
}): ChatSkillRoutingDecision {
  const message = input.message.trim();
  const involved = resolveInvolvedSkills(message, input.activeContext, input.routedDomain);
  const hintedSkill = input.classifierSkillHint
    ? CLASSIFIER_ACTION_SKILL_TO_ORCHESTRATOR_SKILL[input.classifierSkillHint] ?? null
    : null;
  if (hintedSkill && !involved.includes(hintedSkill)) involved.push(hintedSkill);
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
  if (hintedSkill) reasonCodes.push('classifier_skill_ownership_hint');

  if (tenantBoundaryMention) {
    reasonCodes.push('tenant_boundary_requires_confirmation');
  }

  if (!primaryDomain && input.routedDomain) {
    primaryDomain = input.routedDomain;
  }

  // M14 clarify policy (flag-gated, default OFF → clarify stays null and the
  // decision is byte-identical to pre-M14 output).
  const clarify = resolveRoutingClarifyDecision({
    message,
    writeIntent: intentKinds.includes('action'),
    explicitConfirmation,
    locale: input.locale,
    lastAssistantMessage: input.activeContext?.lastAssistantMessage ?? null,
  });
  if (clarify) reasonCodes.push('clarify_ambiguous_write_intents');
  // Budget telemetry: counted ONLY when the caller explicitly opts in — the
  // /message pipeline's pre_routing stage (the deciding call that feeds the
  // deterministic routing_clarify terminal) passes countClarifyTelemetry:
  // true exactly once per turn. No heuristic: other callers that happen to
  // pass routedDomain (context engine, simulations, WebSocket) never count.
  if (isRoutingClarifyEnabled() && input.countClarifyTelemetry === true) {
    recordRoutingClarifyDecision(clarify !== null);
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
    clarify,
  };
}

// ─── M14 deterministic clarify policy ───────────────────────────────
//
// Approved policy: clarify on ≤~10% of turns, WRITES ONLY, never reads, one
// templated question max. Trigger: the top-2 calibrated manifest candidates
// (intent-resolution resolver rawScores mapped through the calibration
// table's score buckets) are within the calibrated epsilon AND both clear the
// actionable floor.
//
// RENDERING IS A PIPELINE TERMINAL, NOT A PROMPT HINT: when the pre_routing
// decision carries clarify (flag-on), the /message pipeline's dedicated
// routing_clarify stage responds DIRECTLY with the templated question
// (contract_only finalizer family) — the model is never reached, so the
// stored assistant message IS the template. Loop prevention is therefore
// deterministic: the continuity state's lastAssistantMessage (rebuilt each
// turn from chat-conversation-state via resolveChatActiveContext) is matched
// against the rigid clarify templates — a turn that answers a clarify
// question can never be re-clarified.

const CLARIFY_ACTIONABLE_DOMAINS = new Set<DomainName>(
  Object.values(SKILL_TO_DOMAIN) as DomainName[],
);

export function resolveRoutingClarifyDecision(input: {
  message: string;
  /** True when the orchestrator detected an actionable WRITE intent this turn. */
  writeIntent: boolean;
  /** Explicit-confirmation turns are continuations of a staged action — never derail them. */
  explicitConfirmation: boolean;
  locale?: string | null;
  lastAssistantMessage?: string | null;
  env?: Record<string, string | undefined>;
}): ChatRoutingClarifyDecision | null {
  if (!isRoutingClarifyEnabled(input.env)) return null;
  if (!input.writeIntent) return null; // reads NEVER clarify
  if (input.explicitConfirmation) return null;
  if (input.lastAssistantMessage && isRoutingClarifyQuestion(input.lastAssistantMessage)) {
    return null; // clarify-response turn — max one clarify per exchange
  }

  const actionable: Array<{ domain: DomainName; calibrated: number }> = [];
  const seen = new Set<DomainName>();
  for (const candidate of resolveIntent(input.message)) {
    const domain = candidate.domain as DomainName;
    if (!CLARIFY_ACTIONABLE_DOMAINS.has(domain) || seen.has(domain)) continue;
    seen.add(domain);
    actionable.push({ domain, calibrated: calibrateIntentResolverScore(candidate.rawScore) });
    if (actionable.length === 2) break;
  }
  if (actionable.length < 2) return null;

  const { epsilon, actionableFloor } = getClarifyPolicy();
  const [top, second] = actionable;
  if (top.calibrated < actionableFloor || second.calibrated < actionableFloor) return null;
  if (top.calibrated - second.calibrated > epsilon) return null;

  return {
    question: buildRoutingClarifyQuestion([top.domain, second.domain], input.locale),
    candidateDomains: [top.domain, second.domain],
    calibratedScores: [top.calibrated, second.calibrated],
    reason: 'ambiguous_write_intents',
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

  // M14: the legacy 0.86 constant now routes through the calibration table
  // (bootstrap table preserves 0.86 exactly).
  const canOverride = decision.confidence >= getOrchestratorOverrideThreshold() && (
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
  // Codex QA round 9: explicit prompt bridge for split-intent turns.
  // Even though the model only has the routed domain's tools, it can
  // still NAME the action the other skill should perform and ask the
  // user to confirm or queue it. This is a stopgap behavior bridge
  // until the architectural handoff_to_domain tool lands.
  const crossSkill = decision.intentKinds.includes('cross_skill');
  if (crossSkill && decision.involvedSkills.length > 1) {
    const otherSkills = decision.involvedSkills
      .filter((s) => s !== 'shared_context' && s !== 'tools')
      .filter((s, _, arr) => arr.length > 1)
      .filter((s) => {
        const skillToDomain: Record<string, string> = {
          secretary: 'secretary',
          training: 'triathlon',
          cooking: 'cooking',
          finance: 'finance',
          content: 'content',
        };
        return skillToDomain[s] !== decision.primaryDomain;
      });
    if (otherSkills.length > 0) {
      lines.push(`<cross_skill_bridge other_skills="${otherSkills.join(',')}">`);
      lines.push('This turn touches multiple skills, but only the primary domain\'s tools are available right now.');
      lines.push(`After handling the primary-domain action, explicitly NAME the actions that belong to: ${otherSkills.join(', ')}.`);
      lines.push('Ask the user one focused follow-up to confirm or defer those actions. Do NOT silently drop them.');
      lines.push('Do NOT claim success on the other skill\'s actions — you have no tools for them on this turn.');
      lines.push('</cross_skill_bridge>');
    }
  }
  // M14: clarify is deliberately NOT rendered into the prompt. The clarify
  // decision is a DETERMINISTIC pipeline terminal (the routing_clarify stage
  // responds with the template directly, contract_only family) — a prompt
  // hint would create a second, model-paraphrasable mechanism and break the
  // template-based loop prevention.
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
  if (isManifestRoutingEnabled('orchestrator')) {
    // Same skill set, evidence sourced from the shared manifest vocabulary.
    for (const { skill } of SKILL_PATTERNS) {
      const domain = SKILL_TO_DOMAIN[skill];
      if (domain && manifestDomainMatches(domain, message)) skills.add(skill);
    }
  } else {
    for (const { skill, pattern } of SKILL_PATTERNS) {
      if (pattern.test(message)) skills.add(skill);
    }
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

// M14: branch ORDER is unchanged legacy policy; the branch VALUES route
// through the calibration table (bootstrap reproduces 0.4/0.96/0.92/0.9/
// 0.72/0.84 exactly, so behavior is byte-identical until a corpus-mode
// regeneration replaces them with empirical precision).
function resolveConfidence(input: {
  scheduling: boolean;
  crossSkill: boolean;
  destructive: boolean;
  ambiguousReference: boolean;
  primaryDomain: DomainName | null;
}): number {
  if (!input.primaryDomain) return getOrchestratorBranchConfidence('no_primary_domain');
  if (input.scheduling && input.crossSkill) return getOrchestratorBranchConfidence('scheduling_cross_skill');
  if (input.scheduling) return getOrchestratorBranchConfidence('scheduling');
  if (input.destructive) return getOrchestratorBranchConfidence('destructive');
  if (input.ambiguousReference) return getOrchestratorBranchConfidence('ambiguous_reference');
  return getOrchestratorBranchConfidence('default');
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
