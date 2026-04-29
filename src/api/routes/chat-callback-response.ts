// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { InlineButton } from '../../adapters/message-adapter';
import type { TodoTask } from '../../services/microsoft-todo';
import { escapeHtml, formatMsTodoTasks } from '../../utils/telegram-formatter';
import {
  buildDeleteConfirmationButtons,
  buildTaskActionButtons,
  type ChatButtonLabels,
} from './chat-inline-buttons';
import type { CallbackScope } from '../../utils/callback-store';

export type ChatCallbackPayload = {
  text: string;
  editOriginal: boolean;
  newButtons: InlineButton[][] | null;
};

type ChatCallbackError = {
  code: string;
  message: string;
};

type CoachRecommendationSummary = {
  summary: string;
};

type DeleteConfirmationItem = {
  title?: unknown;
  listName?: unknown;
  type?: unknown;
};

function isPortuguese(language: string): boolean {
  return language.toLowerCase().startsWith('pt');
}

function callbackCopy(language: string, pt: string, en: string): string {
  return isPortuguese(language) ? pt : en;
}

function callbackItemName(
  language: string,
  value: unknown,
  ptFallback: string,
  enFallback: string,
): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : callbackCopy(language, ptFallback, enFallback);
}

export function buildCallbackInternalErrorMessage(language: string): string {
  return callbackCopy(language, 'Falha ao processar a ação.', 'Failed to process action.');
}

export function buildCallbackDataRequiredError(language: string): ChatCallbackError {
  return {
    code: 'BAD_REQUEST',
    message: callbackCopy(language, 'callbackData é obrigatório', 'callbackData is required'),
  };
}

export function buildUnsupportedCommandCallbackError(
  language: string,
  command: string,
): ChatCallbackError {
  return {
    code: 'UNSUPPORTED_CALLBACK',
    message: callbackCopy(
      language,
      `O atalho "${command}" ainda não está disponível.`,
      `Command callback "${command}" is not available.`,
    ),
  };
}

export function buildCoachDismissPayload(language: string): ChatCallbackPayload {
  return {
    text: callbackCopy(language, '👍 Mantive o plano atual.', '👍 Kept the current plan.'),
    editOriginal: true,
    newButtons: null,
  };
}

export function buildCoachExpiredError(language: string): ChatCallbackError {
  return {
    code: 'CALLBACK_EXPIRED',
    message: callbackCopy(
      language,
      'Esta ação expirou. Gere um novo coach briefing.',
      'This action expired. Generate a new coach briefing.',
    ),
  };
}

export function buildCoachApplyPayload(
  language: string,
  count: number,
  appliedRecommendations: CoachRecommendationSummary[],
): ChatCallbackPayload {
  const summaryLines = appliedRecommendations.slice(0, 4).map((rec) => `• ${rec.summary}`);
  const suffix = appliedRecommendations.length > summaryLines.length
    ? callbackCopy(
        language,
        `\n• … + ${appliedRecommendations.length - summaryLines.length} alterações`,
        `\n• … + ${appliedRecommendations.length - summaryLines.length} more changes`,
      )
    : '';

  return {
    text: callbackCopy(
      language,
      `✅ ${count} recomendação(ões) aplicada(s) ao calendário.\n\n${summaryLines.join('\n')}${suffix}`,
      `✅ Applied ${count} recommendation(s) to your calendar.\n\n${summaryLines.join('\n')}${suffix}`,
    ),
    editOriginal: true,
    newButtons: null,
  };
}

export function buildCallbackExpiredError(language: string): ChatCallbackError {
  return {
    code: 'CALLBACK_EXPIRED',
    message: callbackCopy(
      language,
      'Esta ação expirou. Volta a executar o comando.',
      'This action expired. Please run the command again.',
    ),
  };
}

export function buildTodoListFetchFailurePayload(language: string): ChatCallbackPayload {
  return {
    text: `⚠️ ${callbackCopy(language, 'Falha ao obter tarefas. Tenta novamente.', 'Failed to fetch tasks. Please try again.')}`,
    editOriginal: true,
    newButtons: null,
  };
}

export function buildTodoListSelectionPayload(
  tasks: TodoTask[],
  listName: string,
  language: string,
  labels: ChatButtonLabels,
  scope?: CallbackScope,
): ChatCallbackPayload {
  return {
    text: formatMsTodoTasks(tasks, listName, language),
    editOriginal: true,
    newButtons: buildTaskActionButtons(tasks, labels, 5, scope),
  };
}

export function buildTaskCompletedPayload(language: string, title: unknown): ChatCallbackPayload {
  return {
    text: `✅ ${callbackCopy(language, 'Concluída', 'Completed')}: ${callbackItemName(language, title, 'tarefa', 'task')}`,
    editOriginal: true,
    newButtons: null,
  };
}

export function buildTaskDeletedPayload(language: string, title: unknown): ChatCallbackPayload {
  return {
    text: `🗑️ ${callbackCopy(language, 'Apagada', 'Deleted')}: ${callbackItemName(language, title, 'tarefa', 'task')}`,
    editOriginal: true,
    newButtons: null,
  };
}

export function buildListDeletedPayload(language: string, listName: unknown): ChatCallbackPayload {
  return {
    text: `🗑️ ${callbackCopy(language, 'Lista apagada', 'Deleted list')}: ${callbackItemName(language, listName, 'lista', 'list')}`,
    editOriginal: true,
    newButtons: null,
  };
}

export function buildDeleteConfirmationPayload(
  language: string,
  item: DeleteConfirmationItem,
  confirmRef: string,
  labels: ChatButtonLabels,
): ChatCallbackPayload {
  const isList = item.type === 'list';
  const itemLabel = isList
    ? callbackItemName(language, item.listName, 'lista', 'list')
    : callbackItemName(language, item.title, 'tarefa', 'task');

  return {
    text: isList
      ? `🗑 ${callbackCopy(language, 'Apagar', 'Delete')} "<b>${escapeHtml(itemLabel)}</b>"?`
      : `🗑 ${callbackCopy(language, 'Apagar', 'Delete')} "<b>${escapeHtml(itemLabel)}</b>"?`,
    editOriginal: true,
    newButtons: buildDeleteConfirmationButtons(confirmRef, labels),
  };
}

export function buildCancelledPayload(language: string): ChatCallbackPayload {
  return {
    text: callbackCopy(language, 'Cancelado.', 'Cancelled.'),
    editOriginal: true,
    newButtons: null,
  };
}

export function buildUnsupportedCallbackError(
  language: string,
  prefix: string,
): ChatCallbackError {
  return {
    code: 'UNSUPPORTED_CALLBACK',
    message: callbackCopy(
      language,
      `O callback "${prefix}" ainda não é suportado no chat iOS.`,
      `Callback "${prefix}" is not supported in iOS chat yet.`,
    ),
  };
}
