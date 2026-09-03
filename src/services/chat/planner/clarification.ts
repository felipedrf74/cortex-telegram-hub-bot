// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { findChatActionDefinition } from '../registry';
import type { ChatPlannerInput, ChatPlanStep } from '../types';
import { loadCapabilityManifest } from '../../capability-manifest';

// ─── M14: routing clarify question (manifest displayNames) ──────────
//
// One templated question for the flag-gated routing clarify policy
// (chat-skill-orchestrator resolveRoutingClarifyDecision). Locale handling
// follows this module's convention: prefix match on the BCP-47-ish locale
// (pt* → PT, everything else → EN). The templates are intentionally
// rigid so isRoutingClarifyQuestion can deterministically recognize a
// previously asked clarify question (loop prevention: a clarify-response turn
// must never re-clarify).

const ROUTING_CLARIFY_TEMPLATES: RegExp[] = [
  /^Did you mean .+ or .+\?$/,
  /^Queres dizer .+ ou .+\?$/,
  /^¿Te refieres a .+ o a .+\?$/,
];

/** Manifest displayName for a runtime routing domain (first uiSkillMetadata entry). */
function displayNameForRoutingDomain(domain: string): string {
  try {
    const entry = loadCapabilityManifest().capabilities
      .find((capability) => capability.runtimeRouting.domain === domain);
    const displayName = entry?.uiSkillMetadata?.[0]?.displayName;
    if (displayName) return displayName;
  } catch {
    // Manifest unavailable (isolated tests) — fall through to the fallback.
  }
  return domain.charAt(0).toUpperCase() + domain.slice(1);
}

/**
 * Render the single templated routing clarify question ("Did you mean X or
 * Y?") from manifest displayNames, in EN/PT per the locale conventions of
 * this module.
 */
export function buildRoutingClarifyQuestion(
  domains: readonly [string, string],
  locale?: string | null,
): string {
  const [first, second] = domains.map((domain) => displayNameForRoutingDomain(domain));
  if (locale?.startsWith('pt')) return `Queres dizer ${first} ou ${second}?`;
  return `Did you mean ${first} or ${second}?`;
}

/** True when the text is a routing clarify question this module rendered. */
export function isRoutingClarifyQuestion(text: string): boolean {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return false;
  return ROUTING_CLARIFY_TEMPLATES.some((template) => template.test(trimmed));
}

export function missingRequiredFieldsForStep(step: ChatPlanStep): string[] {
  const definition = findChatActionDefinition(step.skill, step.action);
  const requiredFields = definition?.requiredFields ?? [];
  return requiredFields.filter((field) => step.args[field] == null || step.args[field] === '');
}

export function buildTargetedClarificationQuestion(input: ChatPlannerInput, steps: ChatPlanStep[]): string {
  const step = steps.find((candidate) => missingRequiredFieldsForStep(candidate).length > 0);
  if (!step) return defaultClarification(input);
  const missing = missingRequiredFieldsForStep(step);
  const pt = input.locale?.startsWith('pt');
  if (step.action === 'content_rewrite'
    && (missing.includes('sourceText') || missing.includes('objective'))) {
    return pt
      ? 'Envia o texto original e o objetivo juntos, por exemplo: “Reescreve para ficar mais direto: <texto original>”.'
      : 'Send the source copy and rewrite goal together, for example: “Rewrite to be punchier: <source copy>”.';
  }
  if (step.action === 'complete_task' && (missing.includes('taskId') || missing.includes('listId'))) {
    return pt ? 'Qual tarefa devo concluir?' : 'Which task should I mark done?';
  }
  if (missing.length === 1) {
    return targetedFieldQuestion(step, missing[0], pt);
  }
  const labels = missing.map((field) => fieldLabel(field, pt)).join(pt ? ', ' : ', ');
  if (pt) {
    return `Preciso só destes detalhes antes de executar com segurança: ${labels}.`;
  }
  return `I need these details before I can do this safely: ${labels}.`;
}

export function defaultClarification(input: ChatPlannerInput): string {
  return input.locale?.startsWith('pt') ? 'Preciso só de mais um detalhe para continuar.' : 'I need one more detail before I continue.';
}

function targetedFieldQuestion(step: ChatPlanStep, field: string, pt?: boolean): string {
  const event = step.action === 'schedule_event' || step.action === 'update_event' || step.action === 'move_event';
  const task = step.skill === 'tasks';
  if (pt) {
    switch (field) {
      case 'title':
        return event ? 'Qual é o título do evento?' : task ? 'Qual é o título da tarefa?' : 'Qual é o título?';
      case 'startDateTime':
        return event ? 'Quando começa o evento?' : 'Quando começa?';
      case 'endDateTime':
        return event ? 'Quando termina o evento?' : 'Quando termina?';
      case 'timezone':
        return 'Qual é o fuso horário?';
      case 'provider':
        return 'Em que serviço devo fazer isso?';
      case 'dueDate':
      case 'dueDateTime':
        return 'Qual é a data limite?';
      case 'recipient':
        return 'Para quem devo enviar?';
      case 'subject':
        return 'Qual é o assunto?';
      case 'body':
        return 'Qual é a mensagem?';
      case 'decisionId':
        return 'Qual é a decisão?';
      case 'sessionId':
        return 'Qual é a sessão de treino?';
      case 'objective':
        return step.skill === 'content'
          ? 'Qual é o objetivo da reescrita?'
          : 'Qual é o objetivo principal do plano de treino?';
      case 'sourceText':
        return 'Que texto queres reescrever?';
      case 'durationWeeks':
        return 'Quantas semanas deve durar o plano?';
      case 'sessionsPerWeek':
        return 'Quantos dias de treino por semana queres, entre 3 e 7?';
      case 'startPolicy':
        return 'Queres começar hoje ou na próxima semana completa?';
      case 'receiptId':
        return 'Qual recibo ou transação devo usar?';
      case 'category':
        return 'Qual é a categoria?';
      case 'packageId':
        return 'Qual pacote de conteúdo devo usar?';
      case 'platform':
        return 'Qual plataforma de conteúdo devo usar?';
      default:
        return `Preciso só deste detalhe: ${fieldLabel(field, true)}.`;
    }
  }
  switch (field) {
    case 'title':
      return event ? 'What is the event title?' : task ? 'What is the task title?' : 'What title should I use?';
    case 'startDateTime':
      return event ? 'When does the event start?' : 'When should it start?';
    case 'endDateTime':
      return event ? 'When does the event end?' : 'When should it end?';
    case 'timezone':
      return 'Which timezone should I use?';
    case 'provider':
      return 'Which service should I use?';
    case 'dueDate':
    case 'dueDateTime':
      return 'What is the due date?';
    case 'recipient':
      return 'Who should I send it to?';
    case 'subject':
      return 'What subject should I use?';
    case 'body':
      return 'What message should I send?';
    case 'decisionId':
      return 'Which decision should I use?';
    case 'sessionId':
      return 'Which training session should I use?';
    case 'objective':
      return step.skill === 'content'
        ? 'What should the rewrite achieve?'
        : 'What is the main goal for the training plan?';
    case 'sourceText':
      return 'What source copy should I rewrite?';
    case 'durationWeeks':
      return 'How many weeks should the plan last?';
    case 'sessionsPerWeek':
      return 'How many training days per week do you want, from 3 to 7?';
    case 'startPolicy':
      return 'Should the plan start today or next full week?';
    case 'receiptId':
      return 'Which receipt or transaction should I use?';
    case 'category':
      return 'Which category should I use?';
    case 'packageId':
      return 'Which content package should I use?';
    case 'platform':
      return 'Which content platform should I use?';
    default:
      return `I need this detail: ${fieldLabel(field, false)}.`;
  }
}

function fieldLabel(field: string, pt?: boolean): string {
  const labels: Record<string, [string, string]> = {
    title: ['título', 'title'],
    startDateTime: ['data/hora de início', 'start date/time'],
    endDateTime: ['data/hora de fim', 'end date/time'],
    timezone: ['fuso horário', 'timezone'],
    provider: ['serviço', 'service'],
    eventId: ['evento', 'event'],
    changedFields: ['alteração pretendida', 'change to make'],
    dueDate: ['data limite', 'due date'],
    dueDateTime: ['data/hora limite', 'due date/time'],
    recipient: ['destinatário', 'recipient'],
    subject: ['assunto', 'subject'],
    body: ['mensagem', 'message'],
    decisionId: ['decisão', 'decision'],
    sessionId: ['sessão de treino', 'training session'],
    objective: ['objetivo', 'objective'],
    sourceText: ['texto original', 'source copy'],
    durationWeeks: ['duração em semanas', 'duration in weeks'],
    sessionsPerWeek: ['dias de treino por semana', 'training days per week'],
    startPolicy: ['política de início', 'start policy'],
    receiptId: ['recibo ou transação', 'receipt or transaction'],
    category: ['categoria', 'category'],
    packageId: ['pacote de conteúdo', 'content package'],
    platform: ['plataforma de conteúdo', 'content platform'],
    recipeId: ['ID da receita', 'recipe ID'],
    itemId: ['ID do item da despensa', 'pantry item ID'],
    date: ['data', 'date'],
    mealType: ['refeição', 'meal'],
    weekStart: ['semana', 'week'],
    month: ['mês', 'month'],
    action: ['ação', 'action'],
    amount: ['valor', 'amount'],
  };
  const pair = labels[field];
  if (!pair) return field;
  return pt ? pair[0] : pair[1];
}
