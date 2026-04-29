// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { InlineButton } from '../../adapters/message-adapter';
import type { TodoList, TodoTask } from '../../services/microsoft-todo';
import type { CoachRecommendation } from '../../services/garmin-coach';
import { storeCallback, storeCallbackForScope, type CallbackScope } from '../../utils/callback-store';

export interface ChatButtonLabels {
  today: string;
  tasks: string;
  week: string;
  lists: string;
  completePrefix: string;
  deleteShort: string;
  confirmDelete: string;
  cancel: string;
  applyAll: string;
  keepAll: string;
}

export function labelsForLanguage(lang: string | undefined): ChatButtonLabels {
  const isPT = !!lang && lang.toLowerCase().startsWith('pt');
  return isPT
    ? {
        today: '📅 Hoje',
        tasks: '📋 Tarefas',
        week: '🗓 Semana',
        lists: '🗂 Listas',
        completePrefix: '✅ ',
        deleteShort: '🗑',
        confirmDelete: '🗑 Apagar',
        cancel: 'Cancelar',
        applyAll: '✅ Aplicar tudo',
        keepAll: '👍 Manter tudo',
      }
    : {
        today: '📅 Today',
        tasks: '📋 Tasks',
        week: '🗓 Week',
        lists: '🗂 Lists',
        completePrefix: '✅ ',
        deleteShort: '🗑',
        confirmDelete: '🗑 Delete',
        cancel: 'Cancel',
        applyAll: '✅ Apply all',
        keepAll: '👍 Keep all',
      };
}

export function buildSecretaryQuickActionButtons(labels: ChatButtonLabels): InlineButton[][] {
  return [[
    { text: labels.today, callbackData: 'cmd:/day' },
    { text: labels.tasks, callbackData: 'cmd:/todo_summary' },
    { text: labels.week, callbackData: 'cmd:/week' },
  ]];
}

function storeScopedOrLegacyCallback(
  data: Record<string, unknown>,
  scope: CallbackScope | undefined,
  actionType: string,
): string {
  if (!scope) return storeCallback(data);
  return storeCallbackForScope(data, { ...scope, actionType });
}

export function buildListSelectionButtons(
  lists: TodoList[],
  labels: ChatButtonLabels,
  limit = 10,
  scope?: CallbackScope,
): InlineButton[][] {
  const rows = lists.slice(0, limit).map((list) => {
    const ref = storeScopedOrLegacyCallback({ listId: list.id, listName: list.displayName }, scope, 'todo_list_select');
    return [{ text: list.displayName.slice(0, 28), callbackData: `td:ls:${ref}` }];
  });

  if (rows.length > 0) {
    rows.push(buildSecretaryQuickActionButtons(labels)[0]);
  }

  return rows;
}

export function buildTaskActionButtons(
  tasks: TodoTask[],
  labels: ChatButtonLabels,
  limit = 5,
  scope?: CallbackScope,
): InlineButton[][] {
  const rows = tasks.slice(0, limit).map((task) => {
    const completeRef = storeScopedOrLegacyCallback({
      listId: task.listId,
      taskId: task.id,
      title: task.title,
      listName: task.listName,
    }, scope, 'todo_task_complete');
    const deleteRef = storeScopedOrLegacyCallback({
      listId: task.listId,
      taskId: task.id,
      title: task.title,
      listName: task.listName,
      type: 'task',
    }, scope, 'todo_task_delete_confirm');
    return [
      {
        text: `${labels.completePrefix}${task.title}`.slice(0, 34),
        callbackData: `td:tc:${completeRef}`,
      },
      {
        text: labels.deleteShort,
        callbackData: `td:tx:${deleteRef}`,
      },
    ];
  });

  if (rows.length > 0) {
    rows.push([
      { text: labels.lists, callbackData: 'cmd:/lists' },
      { text: labels.week, callbackData: 'cmd:/week' },
    ]);
  }

  return rows;
}

export function buildDeleteConfirmationButtons(ref: string, labels: ChatButtonLabels): InlineButton[][] {
  return [[
    { text: labels.confirmDelete, callbackData: `td:dy:${ref}` },
    { text: labels.cancel, callbackData: `td:dn:${ref}` },
  ]];
}

export function buildCoachRecommendationButtons(
  recommendations: CoachRecommendation[],
  labels: ChatButtonLabels,
  limit = 4,
  scope?: CallbackScope,
): InlineButton[][] {
  const actionable = recommendations
    .filter((rec) => rec.action !== 'KEEP')
    .slice(0, limit);

  const rows = actionable.map((rec) => {
    const ref = storeScopedOrLegacyCallback({ recommendationIds: [rec.eventId] }, scope, 'coach_recommendation_apply');
    const emoji = rec.action === 'MODIFY'
      ? '⚠️'
      : rec.action === 'SWAP'
        ? '🔄'
        : '❌';
    return [{
      text: `${emoji} ${rec.summary}`.slice(0, 60),
      callbackData: `coach:apply:${ref}`,
    }];
  });

  if (actionable.length > 1) {
    const ref = storeScopedOrLegacyCallback(
      { recommendationIds: actionable.map((rec) => rec.eventId) },
      scope,
      'coach_recommendation_apply_all',
    );
    rows.push([{ text: labels.applyAll, callbackData: `coach:all:${ref}` }]);
  }

  if (rows.length > 0) {
    rows.push([{ text: labels.keepAll, callbackData: 'coach:dismiss' }]);
  }

  return rows;
}
