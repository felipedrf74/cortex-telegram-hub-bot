// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { findChatActionDefinition } from '../registry';
import type { ChatPlannerInput, ChatPlanStep } from '../types';

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
      case 'sport':
        return 'Qual modalidade deve orientar o plano de treino?';
      case 'goal':
        return 'Qual é o objetivo principal do plano de treino?';
      case 'durationWeeks':
        return 'Quantas semanas deve durar o plano?';
      case 'startDate':
        return 'Quando queres começar o plano?';
      case 'weeklyVolumeKm':
        return 'Quantos quilómetros por semana estás a fazer agora?';
      case 'receiptId':
        return 'Qual recibo ou transação devo usar?';
      case 'category':
        return 'Qual é a categoria?';
      case 'packageId':
        return 'Qual pacote de content devo usar?';
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
    case 'sport':
      return 'Which sport should the training plan focus on?';
    case 'goal':
      return 'What is the main goal for the training plan?';
    case 'durationWeeks':
      return 'How many weeks should the plan last?';
    case 'startDate':
      return 'When should the plan start?';
    case 'weeklyVolumeKm':
      return 'What is your current weekly mileage in km?';
    case 'receiptId':
      return 'Which receipt or transaction should I use?';
    case 'category':
      return 'Which category should I use?';
    case 'packageId':
      return 'Which content package should I use?';
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
    sport: ['modalidade', 'sport'],
    goal: ['objetivo', 'goal'],
    durationWeeks: ['duração em semanas', 'duration in weeks'],
    startDate: ['data de início', 'start date'],
    weeklyVolumeKm: ['volume semanal em km', 'weekly mileage in km'],
    receiptId: ['recibo ou transação', 'receipt or transaction'],
    category: ['categoria', 'category'],
    packageId: ['pacote de content', 'content package'],
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
