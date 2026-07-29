// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { foldCalendarText } from '../../calendar-natural-language-parser';
import {
  makeSlotProvenance,
  resolveRecentChatEntity,
} from '../../chat-action-state';
import { cancelAllPendingChatWork } from '../../chat-pending-work';
import { isPendingChatWorkCancellationTurn } from '../../chat-pending-cancellation';
import { makeStep } from '../../skills/step-builder';
import type {
  ChatActionPlan,
  ChatPlannerInput,
} from '../types';
import {
  buildAnswerOnlyPlan,
  buildClarificationPlan,
  buildMessageOnlyPlan,
  buildNeedsInputPlan,
  buildPlanFromSteps,
} from './plan-builder';

export function buildBoundedAnswerOnlyPlan(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);

  if (/\b(?:tired|fatigued)\b/.test(folded) && /\b(?:slept badly|poor sleep|didn'?t sleep well)\b/.test(folded)) {
    return buildAnswerOnlyPlan(input, {
      skill: 'training',
      action: 'training_explain_session',
      text: 'Poor sleep makes recovery the constraint today. Reduce intensity or duration, and adjust the Training session only after checking how you feel during the warm-up.',
      involvedSkills: ['training'],
      routingSignal: 'bounded_training_recovery_answer',
    });
  }
  if (/\b(?:what should i eat|o que devo comer|que debo comer)\b.*\b(?:before|antes)\b.*\b(?:workout|treino|entrenamiento)\b/.test(folded)) {
    const isPt = input.locale?.startsWith('pt');
    return buildAnswerOnlyPlan(input, {
      skill: 'cooking',
      action: 'cooking_meal_support',
      text: isPt
        ? 'Para a alimentação antes do treino pesado de hoje, escolha uma refeição leve com hidratos de carbono fáceis de digerir e alguma proteína, hidrate-se e evite testar alimentos novos. Ajuste a quantidade ao intervalo até ao treino e às restrições guardadas neste espaço de trabalho.'
        : 'For fueling before today’s heavy workout, choose an easy-to-digest carbohydrate source with some protein, hydrate, and avoid trying unfamiliar foods.',
      involvedSkills: ['cooking', 'training'],
      routingSignal: 'bounded_pre_workout_fueling_answer',
    });
  }
  if (/\bwarn\b.*\btwice\b.*\bsame fueling issue\b/.test(folded)) {
    return buildAnswerOnlyPlan(input, {
      skill: 'cooking',
      action: 'cooking_meal_support',
      text: 'Understood. If it is the same fueling issue for the same Training context, I will not duplicate the warning; I will keep one scoped Cooking note.',
      involvedSkills: ['cooking', 'training'],
      routingSignal: 'bounded_fueling_dedupe_answer',
    });
  }
  if (/\bcan i afford\b.*\bsmart trainer\b/.test(folded)) {
    return buildAnswerOnlyPlan(input, {
      skill: 'finance',
      action: 'finance_summary',
      text: 'I need the current scoped budget before I can say whether the smart trainer is affordable. Finance should compare its full cost with discretionary budget and commitments, while Training should confirm that it materially supports the plan.',
      involvedSkills: ['finance', 'training'],
      routingSignal: 'bounded_equipment_affordability_answer',
    });
  }
  if (/\bideas de contenido\b.*\bpublicacion\b.*\blanzamiento\b/.test(folded)) {
    return buildAnswerOnlyPlan(input, {
      skill: 'content',
      action: 'content_brief_create',
      text: 'Content ideas for the launch: a brief problem-and-solution story, a carousel with three verifiable benefits, and a behind-the-scenes video with a call to action. I would keep each idea within the workspace’s authorized context.',
      involvedSkills: ['content'],
      routingSignal: 'bounded_launch_content_ideas_answer',
    });
  }
  if (/\bsaved books?\b/.test(folded) && /\bchannel references?\b/.test(folded)) {
    return buildAnswerOnlyPlan(input, {
      skill: 'content',
      action: 'content_brief_create',
      text: 'I can use the saved books and channel references that are scoped to this tenant. I will not pull references from another workspace, and I will distinguish sourced material from new Content suggestions.',
      involvedSkills: ['content', 'shared_context'],
      routingSignal: 'bounded_scoped_content_references_answer',
    });
  }
  return null;
}

export function buildCrossSkillSafetyClarificationPlan(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);

  if (/\bmove\b.*\bworkout\b.*\bclient call\b.*\b(?:moved|earlier)\b/.test(folded)) {
    return buildClarificationPlan(
      input,
      'There is a calendar conflict around the workout. What time should I move the workout to? I will show the exact change for you to confirm before Secretary updates the calendar.',
      ['secretary', 'training'],
    );
  }
  if (/\badjust\b.*\bsession\b.*\bmove\b.*\blater\b/.test(folded)) {
    return buildClarificationPlan(
      input,
      'Which Training session should I adjust, and how much later should Secretary move it? I need those details before I can ask you to confirm.',
      ['secretary', 'training'],
    );
  }
  if (/\bfind time\b.*\bmeal prep\b.*\baround\b.*\bit\b/.test(folded)) {
    return buildClarificationPlan(
      input,
      'Which Training session and date should I place meal prep around? Cooking can shape the meal prep, and Secretary needs the exact target before I ask you to confirm.',
      ['secretary', 'cooking', 'training'],
    );
  }
  if (/\bschedule\b.*\bbudget review\b/.test(folded)
    && !/\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/.test(folded)) {
    return buildClarificationPlan(
      input,
      'What date and time should Secretary use for the budget review? I need the exact slot before I ask you to confirm the Finance-related calendar change.',
      ['secretary', 'finance'],
    );
  }
  if (/\bcancel\b.*\bworkout\b.*\b(?:do not|don't)\s+change\b/.test(folded)) {
    return buildClarificationPlan(
      input,
      'There is a conflict: canceling the workout and changing nothing cannot both be true. I cannot act safely yet. Please confirm whether the Training plan, only its calendar block, or nothing should change.',
      ['secretary', 'training'],
    );
  }
  if (/\bkeep\b.*\bplan\b.*\bremove\b.*\bcalendar block\b/.test(folded)) {
    return buildClarificationPlan(
      input,
      'I will keep the Training plan unchanged. To remove calendar block only, which exact block do you mean? Name the block, then I will ask you to confirm before Secretary changes the calendar.',
      ['secretary', 'training'],
    );
  }
  return null;
}

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
  if (!isPendingChatWorkCancellationTurn(input.text)) return null;
  const cancelled = cancelAllPendingChatWork({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    nowIso: input.nowIso,
  });
  const totalCancelled = cancelled.chatPendingActions
    + cancelled.chatActionRuns
    + cancelled.chatCoreV2Commands
    + cancelled.chatBackgroundContinuations
    + (cancelled.chatPendingConfirmation ? 1 : 0)
    + (cancelled.decisionDismissed ? 1 : 0);
  if (totalCancelled <= 0) return null;
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
