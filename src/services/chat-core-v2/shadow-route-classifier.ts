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

  if (/\b(dismiss|close|ignore|drop|dispensar|descartar|ignorar|fechar)\b.*\b(decision|choice|decis(?:ao|oes|ão|ões)|escolha)\b/i.test(normalized)) {
    return { intent: 'modify_action', confidence: 0.82, domains: ['decision_center'], capabilityIds: ['decision_center.dismiss'] };
  }

  if (hasCalendarWriteIntent(normalized)) {
    return {
      intent: 'create_action',
      confidence: 0.84,
      domains: ['secretary'],
      capabilityIds: ['secretary.schedule_event_preview'],
    };
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

  if (/\b(create|add|new)\b.*\b(task|todo|to-do)\b|\b(criar|cria|adicionar|adiciona|nova?)\b.*\btarefas?\b|\b(task|todo|to-do)\b.*\b(tomorrow|today|later)\b/i.test(normalized)) {
    return { intent: 'create_action', confidence: 0.88, domains: ['tasks'], capabilityIds: ['tasks.create'] };
  }
  if (/\b(complete|done|finish|mark)\b.*\b(task|todo|to-do)\b|\b(concluir|completar|terminar|marcar)\b.*\btarefas?\b/i.test(normalized)) {
    return { intent: 'modify_action', confidence: 0.84, domains: ['tasks'], capabilityIds: ['tasks.complete'] };
  }
  if (/\b(snooze|pause|adiar|pausar|suspender)\b.*\b(notifications?|alerts?|reminders?|notifica(?:cao|coes|ção|ções)|alertas?|lembretes?)\b/i.test(normalized)) {
    return { intent: 'modify_action', confidence: 0.83, domains: ['notifications'], capabilityIds: ['notifications.snooze'] };
  }
  if (/\b(reconnect|retry|sync|reauth)\b.*\b(connections?|integrations?|providers?|google|outlook|garmin|apple health|strava|todoist|notion)\b|\b(connections?|integrations?|providers?|google|outlook|garmin|apple health|strava|todoist|notion)\b.*\b(reconnect|retry|sync|reauth)\b/i.test(normalized)) {
    return { intent: 'modify_action', confidence: 0.83, domains: ['connections'], capabilityIds: ['connections.retry_sync'] };
  }
  if (/\b(move|reschedule|change|make|lighter|reduce)\b.*\b(workout|training|session)\b|\b(workout|training|session)\b.*\b(lighter|easier|easy|reduce)\b/i.test(normalized)) {
    return { intent: 'modify_action', confidence: 0.83, domains: ['training'], capabilityIds: ['training.modify_session_preview'] };
  }
  if (/\b(add|buy|create|adicionar|adiciona|acrescentar|acrescenta|comprar|compra|agregar|añadir|anadir|crear)\b.*\b(grocery|groceries|ingredient|ingredients|shopping|compras|ingredientes?|lista\s+de\s+compras|lista\s+de\s+la\s+compra)\b/i.test(normalized)) {
    return { intent: 'create_action', confidence: 0.8, domains: ['cooking'], capabilityIds: ['cooking.grocery_item_preview'] };
  }
  if (/\b(create|draft|write|prepare)\b.*\b(?:content\s+)?brief(?:ing)?\b|\bbrief(?:ing)?\b.*\b(content|post|script|reel|video|newsletter)\b|\b(criar|cria|preparar|prepara|escrever|escreve)\b.*\bbrief(?:ing)?\s+de\s+conte[uú]do\b|\b(crear|preparar|escribir|redactar)\b.*\bbrief(?:ing)?\s+de\s+contenido\b/i.test(normalized)) {
    return { intent: 'create_action', confidence: 0.8, domains: ['content'], capabilityIds: ['content.brief_draft_preview'] };
  }
  if (/\b(pay|payment|tax|send money|transfer)\b/i.test(normalized)) {
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
  if (/\b(task|tasks|todo|to-do|tarefas?)\b/i.test(text)) domains.push('tasks');
  if (/\b(training|workout|run|session)\b/i.test(text)) domains.push('training');
  if (/\b(content|script|post|pipeline)\b/i.test(text)) domains.push('content');
  if (/\b(cooking|meals?|grocery|groceries|ingredients?)\b/i.test(text)) domains.push('cooking');
  if (/\b(finance|invoice|receipt|budget|tax|payment)\b/i.test(text)) domains.push('finance');
  if (/\b(connections?|connect|integrations?|providers?)\b|\bconex(?:ão|ões|ao|oes)\b|\bintegra(?:ção|ções|cao|coes)\b/i.test(text)) domains.push('connections');
  if (/\b(notifications?|alerts?|reminders?)\b|\bnotifica(?:ção|ções|cao|coes)\b|\blembretes?\b/i.test(text)) domains.push('notifications');
  if (/\b(decision|choice|decision center)\b/i.test(text)) domains.push('decision_center');
  return [...new Set(domains)];
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
