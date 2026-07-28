// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2Intent } from './route-decision';
import type { ChatCoreV2Domain, UnsupportedReason } from './types';
import { hasCalendarWriteIntent } from '../calendar-natural-language-parser';
import { isManifestRoutingEnabled } from '../intent-resolution/manifest-routing-flags';
import { manifestDomainMatchesLocaleTier } from '../intent-resolution/manifest-projections';

// ─── M12 manifest convergence (flag: AI_ROUTING_MANIFEST_SHADOW) ─
//
// MISROUTE-FIX CONVENTION (flag on): fix a misroute with ONE manifest
// vocabulary edit (config/capability-manifest.json routingVocabulary) plus ONE
// corpus fixture — never by adding a new inline regex to this file. The inline
// per-domain regexes below remain the flag-OFF legacy path only.
//
// Flag-on scope: guessDomains and the per-domain READ-SHORTCUT domain signals
// are compiled from the manifest vocabulary's LOCALE TIER
// (manifestDomainMatchesLocaleTier) — the per-language keyword lists this
// surface's legacy vocabulary was extracted into. The fragment tier (verbatim
// regexes from the richer surfaces) is deliberately excluded here: M12 parity
// measurement showed the fragment union over-matches this surface.
// Read-QUESTION matchers (what/which/show/...), action-intent regexes, and
// the tasks-vs-secretary discriminators stay code-owned (the manifest's axis
// is domain vocabulary — it has no intent-kind or v2-subdomain dimension).
//
// SAFETY FILTERS ARE CODE-OWNED POLICY, NEVER MANIFEST-DRIVEN:
// FINANCE_RESTRICTED_ACTION_RE and the unsafe-access filter below must keep
// working even with an empty or edited manifest vocabulary. Pinned by
// __tests__/services/intent-resolution/manifest-routing-safety-ownership.test.ts.

export interface ChatCoreV2ShadowRouteGuess {
  intent: ChatCoreV2Intent;
  confidence: number;
  domains: ChatCoreV2Domain[];
  capabilityIds: string[];
  unsupportedReason?: UnsupportedReason;
}

/**
 * M12 — explicit DOMAIN SET mapping between Chat Core v2 domains and the
 * CapabilityManifest (legacy runtime) domain space. Both `secretary` and
 * `tasks` project from the manifest `secretary` capability; the split between
 * them is a v2 domain-model refinement expressed by the code-owned
 * discriminators in guessDomains, not by manifest vocabulary.
 */
export const SHADOW_DOMAIN_TO_MANIFEST_DOMAIN: Record<ChatCoreV2Domain, string> = {
  secretary: 'secretary',
  tasks: 'secretary',
  training: 'triathlon',
  content: 'content',
  cooking: 'cooking',
  finance: 'finance',
  connections: 'connections',
  notifications: 'notifications',
  decision_center: 'decision_center',
};

const FINANCE_RESTRICTED_ACTION_RE =
  /\b(pay|payment|send\s+money|transfer|wire|invoice|tax|pagar|paga|pague|pagamento|transferir|transfere|enviar\s+dinheiro|fatura|factura|boleto|imposto|impuesto|pago)\b/i;
const DECISION_NOUN_PATTERN = String.raw`(?:decision|choice|decis(?:ao|oes|ão|ões|ion|ión|iones)|escolhas?|elecci(?:on|ón|ones))`;
const TASK_READ_QUESTION_RE =
  /\b(?:do\s+i\s+have|what\s+(?:tasks?|todos?)|which\s+(?:tasks?|todos?)|show\s+me|list|tenho|que\s+tenho|quais?\s+(?:tarefas?|tareas?)|tengo|qu[eé]\s+(?:tareas?|pendientes?))\b.*\b(?:tasks?|todos?|to-dos?|tarefas?|tareas?|complete|concluir|completar|completadas?)\b/i;

export function classifyShadowRoute(text: string): ChatCoreV2ShadowRouteGuess {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return {
      intent: 'ambiguous',
      confidence: 0.4,
      domains: [],
      capabilityIds: [],
    };
  }

  if (/\b(ignore|bypass)\s+(?:all\s+)?(?:access|permission|skill)|enable\s+every\s+skill|delete\s+all|wipe\s+all\b/i.test(normalized)) {
    return {
      intent: 'unsafe_or_disallowed',
      confidence: 0.96,
      domains: [],
      capabilityIds: [],
      unsupportedReason: 'unsafe_action',
    };
  }

  const decisionActionMatch =
    new RegExp(String.raw`\b(dismiss|close|ignore|drop|snooze|postpone|dispensar|dispensa|dispense|descartar|descarta|descarte|ignorar|ignora|ignore|fechar|fecha|feche|adiar|adia|adie|pausar|pausa|pause|posponer|posp[oó]n|postergar|faz(?:er)?\s+snooze)\b.*\b${DECISION_NOUN_PATTERN}\b`, 'i').test(normalized);
  if (decisionActionMatch) {
    const isSnoozeAction = /\b(snooze|postpone|adiar|adia|adie|pausar|pausa|pause|posponer|posp[oó]n|postergar|faz(?:er)?\s+snooze)\b/i.test(normalized);
    return {
      intent: 'modify_action',
      confidence: 0.82,
      domains: ['decision_center'],
      capabilityIds: [isSnoozeAction ? 'decision_center.snooze' : 'decision_center.dismiss'],
    };
  }

  if (/\b(create|add|new)\b.*\b(task|todo|to-do|tarefas?|tareas?)\b|\b(criar|cria|crie|adicionar|adiciona|nova?|crear|crea|agregar|añadir|anadir)\b.*\b(tasks?|todos?|to-dos?|tarefas?|tareas?)\b|\b(task|todo|to-do)\b.*\b(tomorrow|today|later)\b/i.test(normalized)) {
    return { intent: 'create_action', confidence: 0.88, domains: ['tasks'], capabilityIds: ['tasks.create'] };
  }

  if (hasCalendarWriteIntent(normalized)) {
    return {
      intent: 'create_action',
      confidence: 0.84,
      domains: ['secretary'],
      capabilityIds: ['secretary.schedule_event_preview'],
    };
  }

  if (isContentReadShortcut(normalized)) {
    return { intent: 'app_question', confidence: 0.84, domains: ['content'], capabilityIds: ['content.pipeline_summary'] };
  }

  if (isTrainingReadShortcut(normalized)) {
    const domains = guessDomains(normalized);
    const selectedDomains: ChatCoreV2Domain[] = domains.includes('training') ? domains : ['training'];
    return { intent: 'app_question', confidence: 0.85, domains: selectedDomains, capabilityIds: capabilityIdsForDomains(selectedDomains) };
  }

  if (/\b(plan|organize|optimise|optimize|schedule)\b.*\b(week|day|training|task|meeting|meal)\b/i.test(normalized)) {
    const domains = guessDomains(normalized);
    const selectedDomains: ChatCoreV2Domain[] = domains.length > 0 ? domains : ['tasks'];
    return {
      intent: 'planning',
      confidence: 0.78,
      domains: selectedDomains,
      capabilityIds: capabilityIdsForDomains(selectedDomains),
    };
  }

  if (!TASK_READ_QUESTION_RE.test(normalized) && /\b(complete|done|finish|mark)\b.*\b(task|todo|to-do)\b|\b(concluir|completar|terminar|marcar)\b.*\b(?:tarefas?|tareas?)\b|\b(?:marca|marcar|marque)\b.*\b(?:tareas?)\b/i.test(normalized)) {
    return { intent: 'modify_action', confidence: 0.84, domains: ['tasks'], capabilityIds: ['tasks.complete'] };
  }
  if (/\b(snooze|pause|adiar|pausar|suspender)\b.*\b(notifications?|alerts?|reminders?|notifica(?:cao|coes|ção|ções)|alertas?|lembretes?)\b/i.test(normalized)) {
    return { intent: 'modify_action', confidence: 0.83, domains: ['notifications'], capabilityIds: ['notifications.snooze'] };
  }
  if (/\b(reconnect|retry|sync|reauth)\b.*\b(connections?|integrations?|providers?|google|outlook|garmin|apple health|strava|todoist|notion)\b|\b(connections?|integrations?|providers?|google|outlook|garmin|apple health|strava|todoist|notion)\b.*\b(reconnect|retry|sync|reauth)\b/i.test(normalized)) {
    return { intent: 'modify_action', confidence: 0.83, domains: ['connections'], capabilityIds: ['connections.retry_sync'] };
  }
  if (/\b(move|reschedule|change|make|lighter|reduce|mover|remarcar|mudar|alterar|reduzir|reduz|tornar|deixar|cambiar|hacer|bajar)\b.*\b(workout|training|session|treino|sess(?:ao|ão)|entrenamiento|sesion|sesión)\b|\b(workout|training|session|treino|sess(?:ao|ão)|entrenamiento|sesion|sesión)\b.*\b(lighter|easier|easy|reduce|mais\s+leve|leve|suave|menos\s+intens[ao]|mas\s+suave|más\s+suave)\b/i.test(normalized)) {
    return { intent: 'modify_action', confidence: 0.83, domains: ['training'], capabilityIds: ['training.modify_session_preview'] };
  }
  if (/\b(add|buy|create|adicionar|adiciona|acrescentar|acrescenta|comprar|compra|agregar|añadir|anadir|crear)\b.*\b(grocery|groceries|ingredient|ingredients|shopping|compras|ingredientes?|lista\s+de\s+compras|lista\s+de\s+la\s+compra)\b/i.test(normalized)) {
    return { intent: 'create_action', confidence: 0.8, domains: ['cooking'], capabilityIds: ['cooking.grocery_item_preview'] };
  }
  if (/\b(create|draft|write|prepare)\b.*\b(?:content\s+)?brief(?:ing)?\b|\bbrief(?:ing)?\b.*\b(content|post|script|reel|video|newsletter)\b|\b(criar|cria|preparar|prepara|escrever|escreve)\b.*\bbrief(?:ing)?\s+de\s+conte[uú]do\b|\b(crear|preparar|escribir|redactar)\b.*\bbrief(?:ing)?\s+de\s+contenido\b/i.test(normalized)) {
    return { intent: 'create_action', confidence: 0.8, domains: ['content'], capabilityIds: ['content.brief_draft_preview'] };
  }
  if (isFinanceReadShortcut(normalized)) {
    return { intent: 'app_question', confidence: 0.84, domains: ['finance'], capabilityIds: ['finance.summary'] };
  }
  if (FINANCE_RESTRICTED_ACTION_RE.test(normalized)) {
    return {
      intent: 'unsafe_or_disallowed',
      confidence: 0.9,
      domains: ['finance'],
      capabilityIds: ['finance.payment_or_tax_action_blocked'],
      unsupportedReason: 'restricted_domain',
    };
  }

  const domains = guessDomains(normalized);
  if (domains.length > 0) {
    return {
      intent: 'app_question',
      confidence: 0.82,
      domains,
      capabilityIds: capabilityIdsForDomains(domains),
    };
  }

  return {
    intent: 'general_question',
    confidence: 0.62,
    domains: [],
    capabilityIds: [],
    unsupportedReason: 'not_built',
  };
}

// Code-owned v2 sub-domain discriminators: the manifest `secretary` capability
// covers both v2 `secretary` and v2 `tasks`; these narrow regexes decide which
// v2 domain(s) a secretary-vocabulary match belongs to. They are NOT domain
// vocabulary and stay inline when the manifest flag is on.
const SECRETARY_SUBDOMAIN_DISCRIMINATOR_RE = /\b(agenda|calendar|meeting|schedule|secretary)\b/i;
const TASKS_SUBDOMAIN_DISCRIMINATOR_RE = /\b(task|tasks|todo|to-do|tarefas?|tareas?)\b/i;

// Code-owned precedence matcher (M12): an explicit content-creation ask
// (creation verb + content artifact noun — derived from the classifier's
// CONTENT_INTENT tier) must beat SUBJECT-MATTER-ONLY vocabulary from other
// domains, e.g. "Write a short script about recovery after hard intervals"
// is a content ask, not a training one. Intent-kind precedence is not a
// manifest axis, so this stays inline like the other precedence matchers.
const CONTENT_CREATION_INTENT_RE =
  /\b(write|create|generate|make|draft|outline|rewrite|improve|give|suggest|organi[sz]e|prioriti[sz]e|escrev(?:e|a)|cria|crie|gera|gerar|faz|faça|rascunha|reescreve|melhora|escribe|escribir|crea|crear|genera|redacta|redactar)\b[\s\S]{0,80}\b(script|caption|hooks?|titles?|thumbnails?|reels?|videos?|posts?|content|newsletter|roteiros?|legendas?|ganchos?|t[ií]tulos?|miniaturas?|v[ií]deos?|conte[uú]do|guiones?|leyendas?|contenido)\b/i;

// Direct training-noun evidence, shared between the legacy guessDomains
// branch and the manifest-path content-creation filter so the two stay in
// sync. Training subject vocabulary (recovery, intervals, intensity, ...)
// that only exists in the training READ-signal list / manifest locale tier
// deliberately does NOT count as direct evidence here.
const TRAINING_DIRECT_NOUN_RES: RegExp[] = [
  /\b(training|workouts?|run|session)\b/i,
  /\b(treinos?|treinar|corrida|sess(?:ao|ão|oes|ões))\b/i,
  /\b(entrenamientos?|entrenar|carrera|sesiones?|sesión)\b/i,
];

function hasDirectTrainingNoun(text: string): boolean {
  return TRAINING_DIRECT_NOUN_RES.some((pattern) => pattern.test(text));
}

function guessDomainsViaManifest(text: string): ChatCoreV2Domain[] {
  const domains: ChatCoreV2Domain[] = [];
  const secretaryVocabulary = manifestDomainMatchesLocaleTier(SHADOW_DOMAIN_TO_MANIFEST_DOMAIN.secretary, text);
  if (secretaryVocabulary && SECRETARY_SUBDOMAIN_DISCRIMINATOR_RE.test(text)) domains.push('secretary');
  if (secretaryVocabulary && TASKS_SUBDOMAIN_DISCRIMINATOR_RE.test(text)) domains.push('tasks');
  const oneToOne: ChatCoreV2Domain[] = [
    'training', 'content', 'cooking', 'finance', 'connections', 'notifications', 'decision_center',
  ];
  for (const domain of oneToOne) {
    if (manifestDomainMatchesLocaleTier(SHADOW_DOMAIN_TO_MANIFEST_DOMAIN[domain], text)) domains.push(domain);
  }
  // Content-creation precedence: when the ask is explicitly "make content"
  // and the ONLY training evidence is subject vocabulary (no direct training
  // noun), training must not lead — or even appear in — the domain set.
  // domains[0] is the primary for v2 consumers (command-preview-route,
  // action-gateway, unsupported-fallback firstDomain).
  if (
    domains.includes('training')
    && domains.includes('content')
    && CONTENT_CREATION_INTENT_RE.test(text)
    && !hasDirectTrainingNoun(text)
  ) {
    return domains.filter((domain) => domain !== 'training');
  }
  return domains;
}

function guessDomains(text: string): ChatCoreV2Domain[] {
  if (isManifestRoutingEnabled('shadow')) return guessDomainsViaManifest(text);
  const domains: ChatCoreV2Domain[] = [];
  if (SECRETARY_SUBDOMAIN_DISCRIMINATOR_RE.test(text)) domains.push('secretary');
  if (TASKS_SUBDOMAIN_DISCRIMINATOR_RE.test(text)) domains.push('tasks');
  if (hasDirectTrainingNoun(text)) domains.push('training');
  if (
    /\b(content|script|post|pipeline|caption|hook|reel|video|newsletter)\b/i.test(text)
    || /\b(pillar|pillars|desk|filming|film|publish|published|performance|performing|performed|learnings?|format|formats?)\b/i.test(text)
    || /\b(conte[uú]do|roteiros?|legendas?|t[ií]tulos?|ganchos?|pilares?|mesa|publicar|publica(?:cao|ção|coes|ções)|filmagens?)\b/i.test(text)
    || /\b(contenido|guiones?|leyendas?|t[ií]tulos?|ganchos?|pilares?|publicar|publicaci[oó]n|filmaciones?)\b/i.test(text)
  ) domains.push('content');
  if (
    /\b(cooking|cook|recipe|recipes|meals?|grocery|groceries|ingredients?|dinner|lunch)\b/i.test(text)
    || /\b(cozinhar|receitas?|jantar|almo[cç]o|ingredientes?|refei(?:cao|ção|coes|ções)|forno|prato)\b/i.test(text)
    || /\b(cocinar|recetas?|cena|almuerzo|ingredientes?|comida|horno|plato)\b/i.test(text)
  ) domains.push('cooking');
  if (
    /\b(finance|financial|budget|spend|spending|income|expense|expenses|balance|summary)\b/i.test(text)
    || /\b(financeir[oa]s?|resumo|or[çc]amento|gasto|gastos|despesa|despesas|renda|entradas|saldo)\b/i.test(text)
    || /\b(financier[oa]s?|resumen|presupuesto|gasto|gastos|ingreso|ingresos|saldo)\b/i.test(text)
  ) domains.push('finance');
  if (/\b(connections?|connect|integrations?|providers?)\b|\bconex(?:ão|ões|ao|oes)\b|\bintegra(?:ção|ções|cao|coes)\b/i.test(text)) domains.push('connections');
  if (/\b(notifications?|alerts?|reminders?)\b|\bnotifica(?:ção|ções|cao|coes)\b|\blembretes?\b/i.test(text)) domains.push('notifications');
  if (new RegExp(String.raw`\b(?:decision center|${DECISION_NOUN_PATTERN})\b`, 'i').test(text)) domains.push('decision_center');
  return [...new Set(domains)];
}

function isContentReadShortcut(text: string): boolean {
  const hasContentSignal = isManifestRoutingEnabled('shadow')
    ? manifestDomainMatchesLocaleTier(SHADOW_DOMAIN_TO_MANIFEST_DOMAIN.content, text)
    : (
      /\b(content|script|post|pipeline|caption|hook|hooks|reel|video|newsletter|pillar|pillars|desk|filming|film|publish|published|performance|performing|performed|learnings?|format|formats?)\b/i.test(text)
      || /\b(conte[uú]do|roteiros?|legendas?|t[ií]tulos?|ganchos?|pilares?|mesa|publicar|publica(?:cao|ção|coes|ções)|filmar|filmagens?|performou|funcionando|aprend(?:endo|er)|formato)\b/i.test(text)
      || /\b(contenido|guiones?|leyendas?|t[ií]tulos?|ganchos?|pilares?|publicar|publicaci[oó]n|filmaciones?|funcionando|aprend(?:iendo|er)|formato)\b/i.test(text)
    );
  if (!hasContentSignal) return false;
  return /\b(what|which|how\s+should|show|list|review|ready|next|best|winning|working|tracking|o\s+que|qual|quais|como\s+devo|mostra|mostrar|pront[oa]s?|melhor|vencendo|funcionando|acompanhand[oa]|qué|que|cu[aá]l|cu[aá]les|c[oó]mo\s+debo|listo|mejor|ganando)\b/i.test(text);
}

function isFinanceReadShortcut(text: string): boolean {
  const hasFinanceReadSignal = isManifestRoutingEnabled('shadow')
    ? manifestDomainMatchesLocaleTier(SHADOW_DOMAIN_TO_MANIFEST_DOMAIN.finance, text)
    : (
      /\b(bills?|invoices?|subscriptions?|renewals?|renew|missing|due|month|finance|financial)\b/i.test(text)
      || /\b(contas?|faturas?|facturas?|assinaturas?|subscri(?:c(?:ao|ão)|coes|ções)|renova(?:r|m|cao|ção|coes|ções)|faltam|falta|m[eê]s|financeir[oa])\b/i.test(text)
      || /\b(facturas?|suscripciones?|renovaciones?|renuevan|faltan|falta|mes|financier[oa])\b/i.test(text)
    );
  if (!hasFinanceReadSignal) return false;
  return /\b(what|which|show|list|summary|quais?|que|o\s+que|mostra|mostrar|resumo|qué|cu[aá]les|resumen)\b/i.test(text);
}

function isTrainingReadShortcut(text: string): boolean {
  const hasTrainingSignal = isManifestRoutingEnabled('shadow')
    ? manifestDomainMatchesLocaleTier(SHADOW_DOMAIN_TO_MANIFEST_DOMAIN.training, text)
    : (
      /\b(training|workouts?|runs?|sessions?|active\s+plan|current\s+plan|adherence|intensity|recovery|soreness|sore|easy)\b/i.test(text)
      || /\b(treinos?|treinar|corrida|sess(?:ao|ão|oes|ões)|plano\s+(?:ativo|atual|de\s+treino)|ades[aã]o|intensidade|recupera(?:cao|ção)|dor\s+muscular|dolorida|leve)\b/i.test(text)
      || /\b(entrenamientos?|entrenar|carrera|sesiones?|sesión|plan\s+(?:activo|actual|de\s+entrenamiento)|adherencia|intensidad|recuperaci[oó]n|dolor|suave)\b/i.test(text)
    );
  if (!hasTrainingSignal) return false;

  return /\b(?:what|which|show|list|how\s+many|do\s+i\s+have|does\s+my|is\s+there|any|current|active)\b/i.test(text)
    || /\b(?:qual|quais|que|mostra|mostrar|lista|liste|quantas?|tenho|há|ha|alguma|meu\s+plano|o\s+meu\s+plano|plano\s+atual|plano\s+ativo)\b/i.test(text)
    || /\b(?:qué|que|cu[aá]l|cu[aá]les|muestra|mostrar|lista|cu[aá]ntas?|tengo|hay|alguna|mi\s+plan|plan\s+actual|plan\s+activo)\b/i.test(text);
}

function capabilityIdsForDomains(domains: ChatCoreV2Domain[]): string[] {
  const capabilityByDomain: Record<ChatCoreV2Domain, string> = {
    secretary: 'secretary.agenda_summary',
    tasks: 'tasks.today_summary',
    training: 'training.session_explain',
    content: 'content.pipeline_summary',
    cooking: 'cooking.meal_plan_summary',
    finance: 'finance.summary',
    connections: 'connections.status',
    notifications: 'notifications.summary',
    decision_center: 'decision_center.summary',
  };
  return domains.map((domain) => capabilityByDomain[domain]);
}
