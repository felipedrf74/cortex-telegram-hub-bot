// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { listTasksForUser } from '../../task-store/task-service';
import type { NormalizedTask } from '../../task-store/types';
import {
  buildChatCoreV2ReadContextPack,
  buildChatCoreV2ReadModelResult,
  isReadModelFreshEnough,
} from '../read-models';
import {
  buildChatCoreV2MessageResponse,
  normalizeChatCoreV2Locale,
} from '../response-contracts';
import {
  MAX_VISIBLE_TASKS,
  TASKS_TODAY_SUMMARY_CAPABILITY,
  hashStable,
  normalizeTimezone,
} from './common';
import { joinParts, plural, type ChatCoreV2NormalizedLocale } from './copy';
import type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2DeterministicReadRouteResult,
  ChatCoreV2TaskSummaryData,
  ChatCoreV2TaskSummaryItem,
} from './types';
import type { ChatCoreV2ShadowRouteGuess } from '../shadow-route-classifier';

export function buildTaskSummaryRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2DeterministicReadRouteResult | null {
  const now = input.now ?? new Date();
  const timezone = normalizeTimezone(input.timezone);
  // Provider-aware read: native users' chat-created tasks live in
  // `native_tasks`, not the unified store. listTasksForUser routes by the
  // user's resolved provider so this read can't report "no open tasks" right
  // after a chat created one.
  const pendingTasks = listTasksForUser(input.userId, { status: 'pending' });
  const data = summarizeTasks(pendingTasks, timezone, now);
  const readModel = buildChatCoreV2ReadModelResult<ChatCoreV2TaskSummaryData>({
    capabilityId: TASKS_TODAY_SUMMARY_CAPABILITY,
    domain: 'tasks',
    data,
    sourceEntityIds: data.topTasks.map((task) => task.entityId),
    sourceVersions: sourceVersionsForTasks(pendingTasks),
    generatedAt: now.toISOString(),
    maxSourceAgeSeconds: 60,
    sensitivity: 'personal',
    summary: buildTaskSummaryText(data, input.locale),
    locale: normalizeChatCoreV2Locale(input.locale),
    now,
  });
  if (!isReadModelFreshEnough(readModel)) return null;

  const contextPack = buildChatCoreV2ReadContextPack([readModel], { generatedAt: now.toISOString() });
  const response = buildChatCoreV2MessageResponse({
    text: readModel.summary ?? buildTaskSummaryText(data, input.locale),
    locale: input.locale,
    reasonCodes: ['deterministic_read', TASKS_TODAY_SUMMARY_CAPABILITY],
  });

  return {
    capabilityId: TASKS_TODAY_SUMMARY_CAPABILITY,
    routeGuess,
    readModel,
    contextPack,
    response,
  };
}

function summarizeTasks(tasks: NormalizedTask[], timezone: string, now: Date): ChatCoreV2TaskSummaryData {
  const today = dateKey(now.toISOString(), timezone, false) ?? now.toISOString().slice(0, 10);
  const items = tasks.map((task) => {
    const dueKey = task.dueDate ? dateKey(task.dueDate, timezone, !task.dueDate.includes('T')) : null;
    const bucket: ChatCoreV2TaskSummaryItem['bucket'] = dueKey == null
      ? 'unscheduled'
      : dueKey < today
        ? 'overdue'
        : dueKey === today
          ? 'today'
          : 'upcoming';
    return {
      entityId: taskEntityId(task),
      title: task.title,
      projectName: task.projectName,
      dueDate: task.dueDate,
      priority: task.priority,
      bucket,
    };
  });

  items.sort((a, b) => {
    const bucketRank = bucketSortRank(a.bucket) - bucketSortRank(b.bucket);
    if (bucketRank !== 0) return bucketRank;
    const priorityRank = b.priority - a.priority;
    if (priorityRank !== 0) return priorityRank;
    return a.title.localeCompare(b.title);
  });

  return {
    pendingCount: tasks.length,
    dueTodayCount: items.filter((task) => task.bucket === 'today').length,
    overdueCount: items.filter((task) => task.bucket === 'overdue').length,
    highPriorityCount: tasks.filter((task) => task.priority >= 3).length,
    timezone,
    topTasks: items.slice(0, MAX_VISIBLE_TASKS),
  };
}

function buildTaskSummaryText(data: ChatCoreV2TaskSummaryData, locale: string | null | undefined): string {
  const normalizedLocale = normalizeChatCoreV2Locale(locale);
  if (data.pendingCount === 0) {
    if (normalizedLocale === 'pt-BR') return 'Você não tem tarefas abertas agora.';
    if (normalizedLocale === 'pt-PT') return 'Não tens tarefas abertas neste momento.';
    if (normalizedLocale === 'es') return 'No tienes tareas abiertas ahora.';
    return 'You have no open tasks right now.';
  }

  const header = buildTaskSummaryHeader(data, normalizedLocale);
  if (data.topTasks.length === 0) return header;
  const taskLines = data.topTasks.map((task) => `- ${task.title}${taskSuffix(task, normalizedLocale)}`);
  return `${header}\n\n${taskListLabel(normalizedLocale)}\n${taskLines.join('\n')}`;
}

function buildTaskSummaryHeader(data: ChatCoreV2TaskSummaryData, locale: ChatCoreV2NormalizedLocale): string {
  const parts: string[] = [];
  if (data.dueTodayCount > 0) parts.push(countPhrase(data.dueTodayCount, locale, 'today'));
  if (data.overdueCount > 0) parts.push(countPhrase(data.overdueCount, locale, 'overdue'));
  if (data.highPriorityCount > 0) parts.push(countPhrase(data.highPriorityCount, locale, 'high_priority'));

  const detail = parts.length > 0 ? ` ${joinParts(parts, locale)}` : '';
  if (locale === 'pt-BR') return `Você tem ${data.pendingCount} ${plural(data.pendingCount, 'tarefa aberta', 'tarefas abertas')}.${detail}`;
  if (locale === 'pt-PT') return `Tens ${data.pendingCount} ${plural(data.pendingCount, 'tarefa aberta', 'tarefas abertas')}.${detail}`;
  if (locale === 'es') return `Tienes ${data.pendingCount} ${plural(data.pendingCount, 'tarea abierta', 'tareas abiertas')}.${detail}`;
  return `You have ${data.pendingCount} open ${data.pendingCount === 1 ? 'task' : 'tasks'}.${detail}`;
}

function countPhrase(
  count: number,
  locale: ChatCoreV2NormalizedLocale,
  kind: 'today' | 'overdue' | 'high_priority',
): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') {
    if (kind === 'today') return `${count} ${plural(count, 'para hoje', 'para hoje')}`;
    if (kind === 'overdue') return `${count} ${plural(count, 'atrasada', 'atrasadas')}`;
    return `${count} ${plural(count, 'com prioridade alta', 'com prioridade alta')}`;
  }
  if (locale === 'es') {
    if (kind === 'today') return `${count} ${plural(count, 'para hoy', 'para hoy')}`;
    if (kind === 'overdue') return `${count} ${plural(count, 'atrasada', 'atrasadas')}`;
    return `${count} ${plural(count, 'de alta prioridad', 'de alta prioridad')}`;
  }
  if (kind === 'today') return `${count} due today`;
  if (kind === 'overdue') return `${count} overdue`;
  return `${count} high priority`;
}

function taskListLabel(locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR') return 'Principais tarefas:';
  if (locale === 'pt-PT') return 'Tarefas principais:';
  if (locale === 'es') return 'Tareas principales:';
  return 'Top tasks:';
}

function taskSuffix(task: ChatCoreV2TaskSummaryItem, locale: ChatCoreV2NormalizedLocale): string {
  if (task.bucket === 'today') {
    if (locale === 'pt-BR' || locale === 'pt-PT') return ' (hoje)';
    if (locale === 'es') return ' (hoy)';
    return ' (today)';
  }
  if (task.bucket === 'overdue') {
    if (locale === 'pt-BR' || locale === 'pt-PT') return ' (atrasada)';
    if (locale === 'es') return ' (atrasada)';
    return ' (overdue)';
  }
  return '';
}

function sourceVersionsForTasks(tasks: NormalizedTask[]): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const task of tasks) {
    versions[taskEntityId(task)] = hashStable({
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate ?? null,
      projectName: task.projectName ?? null,
      completedAt: task.completedAt ?? null,
    });
  }
  return versions;
}

function taskEntityId(task: NormalizedTask): string {
  if (typeof task.id === 'number' && Number.isFinite(task.id)) return `task:${task.id}`;
  return `task:${hashStable({ provider: task.provider, externalId: task.externalId }).slice(0, 12)}`;
}

function bucketSortRank(bucket: ChatCoreV2TaskSummaryItem['bucket']): number {
  if (bucket === 'overdue') return 0;
  if (bucket === 'today') return 1;
  if (bucket === 'upcoming') return 2;
  return 3;
}

function dateKey(value: string, timezone: string, dateOnly: boolean): string | null {
  const isoDate = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateOnly && isoDate) return isoDate[1];

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return isoDate?.[1] ?? null;

  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(parsed);
    const part = (type: string) => parts.find((item) => item.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    return year && month && day ? `${year}-${month}-${day}` : parsed.toISOString().slice(0, 10);
  } catch {
    return parsed.toISOString().slice(0, 10);
  }
}
