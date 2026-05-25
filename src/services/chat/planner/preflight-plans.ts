// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { foldCalendarText } from '../../calendar-natural-language-parser';
import {
  cancelPendingChatActions,
  makeSlotProvenance,
  resolveRecentChatEntity,
} from '../../chat-action-state';
import { makeStep } from '../../skills/step-builder';
import type {
  ChatActionPlan,
  ChatPlannerInput,
} from '../types';
import {
  buildMessageOnlyPlan,
  buildNeedsInputPlan,
  buildPlanFromSteps,
} from './plan-builder';

export function buildAmbiguousActionClarificationPlan(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  const hasScheduleVerb = /\b(schedule|plan|put|book|set up|marca|marcar|agenda|agendar|programa|programar)\b/.test(folded);
  const hasAmbiguousObject = /\b(something|anything|stuff|thing|algo|alguma coisa|coisa|qualquer coisa)\b/.test(folded);
  const hasDateHint = /\b(today|tomorrow|tonight|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hoje|amanha|amanhã|esta\s+semana|proxima\s+semana|próxima\s+semana|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo)\b/.test(folded);
  if (!hasScheduleVerb || !hasAmbiguousObject || !hasDateHint) return null;

  return buildNeedsInputPlan(input, {
    skill: 'secretary_calendar',
    action: 'schedule_event',
    question: input.locale?.startsWith('pt')
      ? 'Queres criar um evento, uma tarefa ou um lembrete?'
      : 'Should I make this an event, a task, or a reminder?',
    args: { rawRequest: input.text },
    routingSignals: ['ambiguous_action_intent', 'clarifying_question'],
    clarificationReason: 'ambiguous_intent',
    intentClass: 'clarifying_question',
  });
}

export function buildPendingCancellationPlan(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  if (!/\b(cancel|cancelar|never mind|nevermind|esquece|deixa|forget it)\b/.test(folded)) return null;
  const cancelled = cancelPendingChatActions({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    nowIso: input.nowIso,
  });
  if (cancelled <= 0) return null;
  return buildMessageOnlyPlan(input, input.locale?.startsWith('pt')
    ? 'Está cancelado. Não vou continuar essa ação pendente.'
    : 'Cancelled. I will not continue that pending action.', 'pending_action_cancelled');
}

export function buildRecentEntityFollowUpPlan(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  if (!/\b(mark|complete|done|finish|concluir|conclui|feito|terminar|marca)\b/.test(folded)) return null;
  if (!/\b(this task|that task|it|this|that|essa tarefa|esta tarefa|isso)\b/.test(folded)) return null;
  const resolved = resolveRecentChatEntity({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    entityType: 'task',
    action: 'complete_task',
    nowIso: input.nowIso,
  });
  if (resolved.status === 'single') {
    const entity = resolved.candidates[0];
    const args = {
      taskId: entity.entityId,
      listId: typeof entity.metadata?.listId === 'string' ? entity.metadata.listId : undefined,
      listName: typeof entity.metadata?.listName === 'string' ? entity.metadata.listName : undefined,
      title: entity.userVisibleLabel,
    };
    if (!args.listId) {
      return buildNeedsInputPlan(input, {
        skill: 'tasks',
        action: 'complete_task',
        question: input.locale?.startsWith('pt')
          ? `Qual tarefa devo concluir: ${entity.userVisibleLabel}?`
          : `Which task should I mark done: ${entity.userVisibleLabel}?`,
        args: {},
        routingSignals: ['recent_entity_followup', 'task_reference_missing_list'],
      });
    }
    const step = makeStep(input, {
      skill: 'tasks',
      action: 'complete_task',
      risk: 'safe_write',
      provider: 'nexus',
      args,
      slotProvenance: {
        taskId: makeSlotProvenance({
          slot: 'taskId',
          value: entity.entityId,
          rawText: input.text,
          turnId: input.messageId,
          sourceType: 'visible_card',
          normalizer: 'recent_entity_graph_v1',
          confidence: entity.confidence,
        }),
      },
      requiredArgsPresent: Boolean(args.taskId && args.listId),
    });
    return buildPlanFromSteps(input, [step], ['recent_entity_followup', 'task_reference_resolved'], 0.94);
  }
  const options = resolved.candidates.map((candidate) => candidate.userVisibleLabel).filter(Boolean).slice(0, 3);
  return buildNeedsInputPlan(input, {
    skill: 'tasks',
    action: 'complete_task',
    question: input.locale?.startsWith('pt')
      ? options.length > 0
        ? `Qual tarefa devo concluir: ${options.join(', ')}?`
        : 'Qual tarefa devo concluir?'
      : options.length > 0
        ? `Which task should I mark done: ${options.join(', ')}?`
        : 'Which task should I mark done?',
    args: {},
    routingSignals: [resolved.status === 'ambiguous' ? 'ambiguous_recent_task_reference' : 'missing_recent_task_reference'],
  });
}
