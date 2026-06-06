// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2Intent } from './route-decision';
import type { ChatCoreV2Domain, UnsupportedReason } from './types';
import { hasCalendarWriteIntent } from '../calendar-natural-language-parser';

export interface ChatCoreV2ShadowRouteGuess {
  intent: ChatCoreV2Intent;
  confidence: number;
  domains: ChatCoreV2Domain[];
  capabilityIds: string[];
  unsupportedReason?: UnsupportedReason;
}

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

function guessDomains(text: string): ChatCoreV2Domain[] {
  const domains: ChatCoreV2Domain[] = [];
  if (/\b(agenda|calendar|meeting|schedule|secretary)\b/i.test(text)) domains.push('secretary');
  if (/\b(task|tasks|todo|to-do|tarefas?|tareas?)\b/i.test(text)) domains.push('tasks');
  if (
    /\b(training|workouts?|run|session)\b/i.test(text)
    || /\b(treinos?|treinar|corrida|sess(?:ao|ão|oes|ões))\b/i.test(text)
    || /\b(entrenamientos?|entrenar|carrera|sesiones?|sesión)\b/i.test(text)
  ) domains.push('training');
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
  const hasContentSignal =
    /\b(content|script|post|pipeline|caption|hook|hooks|reel|video|newsletter|pillar|pillars|desk|filming|film|publish|published|performance|performing|performed|learnings?|format|formats?)\b/i.test(text)
    || /\b(conte[uú]do|roteiros?|legendas?|t[ií]tulos?|ganchos?|pilares?|mesa|publicar|publica(?:cao|ção|coes|ções)|filmar|filmagens?|performou|funcionando|aprend(?:endo|er)|formato)\b/i.test(text)
    || /\b(contenido|guiones?|leyendas?|t[ií]tulos?|ganchos?|pilares?|publicar|publicaci[oó]n|filmaciones?|funcionando|aprend(?:iendo|er)|formato)\b/i.test(text);
  if (!hasContentSignal) return false;
  return /\b(what|which|how\s+should|show|list|review|ready|next|best|winning|working|tracking|o\s+que|qual|quais|como\s+devo|mostra|mostrar|pront[oa]s?|melhor|vencendo|funcionando|acompanhand[oa]|qué|que|cu[aá]l|cu[aá]les|c[oó]mo\s+debo|listo|mejor|ganando)\b/i.test(text);
}

function isFinanceReadShortcut(text: string): boolean {
  const hasFinanceReadSignal =
    /\b(bills?|invoices?|subscriptions?|renewals?|renew|missing|due|month|finance|financial)\b/i.test(text)
    || /\b(contas?|faturas?|facturas?|assinaturas?|subscri(?:c(?:ao|ão)|coes|ções)|renova(?:r|m|cao|ção|coes|ções)|faltam|falta|m[eê]s|financeir[oa])\b/i.test(text)
    || /\b(facturas?|suscripciones?|renovaciones?|renuevan|faltan|falta|mes|financier[oa])\b/i.test(text);
  if (!hasFinanceReadSignal) return false;
  return /\b(what|which|show|list|summary|quais?|que|o\s+que|mostra|mostrar|resumo|qué|cu[aá]les|resumen)\b/i.test(text);
}

function isTrainingReadShortcut(text: string): boolean {
  const hasTrainingSignal =
    /\b(training|workouts?|runs?|sessions?|active\s+plan|current\s+plan|adherence|intensity|recovery|soreness|sore|easy)\b/i.test(text)
    || /\b(treinos?|treinar|corrida|sess(?:ao|ão|oes|ões)|plano\s+(?:ativo|atual|de\s+treino)|ades[aã]o|intensidade|recupera(?:cao|ção)|dor\s+muscular|dolorida|leve)\b/i.test(text)
    || /\b(entrenamientos?|entrenar|carrera|sesiones?|sesión|plan\s+(?:activo|actual|de\s+entrenamiento)|adherencia|intensidad|recuperaci[oó]n|dolor|suave)\b/i.test(text);
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
