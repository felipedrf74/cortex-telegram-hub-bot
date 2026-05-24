// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';

import { listTasks } from '../task-store/task-service';
import type { NormalizedTask } from '../task-store/types';
import { type RuntimeFlagScope } from '../runtime-flags';
import {
  buildChatCoreV2ReadContextPack,
  buildChatCoreV2ReadModelResult,
  isReadModelFreshEnough,
} from './read-models';
import {
  buildChatCoreV2MessageResponse,
  normalizeChatCoreV2Locale,
  type ChatCoreV2Response,
} from './response-contracts';
import { classifyShadowRoute, type ChatCoreV2ShadowRouteGuess } from './shadow-route-classifier';
import {
  isChatCoreV2CapabilityEnabled,
} from './capability-registry';
import type { ChatCoreV2ReadContextPack, ChatCoreV2ReadModelResult } from './types';

export interface ChatCoreV2TaskSummaryItem {
  entityId: string;
  title: string;
  projectName?: string;
  dueDate?: string;
  priority: number;
  bucket: 'overdue' | 'today' | 'upcoming' | 'unscheduled';
}

export interface ChatCoreV2TaskSummaryData {
  pendingCount: number;
  dueTodayCount: number;
  overdueCount: number;
  highPriorityCount: number;
  timezone: string;
  topTasks: ChatCoreV2TaskSummaryItem[];
}

export interface ChatCoreV2DeterministicReadRouteResult {
  capabilityId: 'tasks.today_summary';
  routeGuess: ChatCoreV2ShadowRouteGuess;
  readModel: ChatCoreV2ReadModelResult<ChatCoreV2TaskSummaryData>;
  contextPack: ChatCoreV2ReadContextPack;
  response: ChatCoreV2Response;
}

export interface BuildChatCoreV2DeterministicReadRouteInput {
  normalizedText: string;
  userId: number;
  tenantId: number;
  locale?: string | null;
  timezone?: string | null;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

type ChatCoreV2CapabilityFlagInput = Parameters<typeof isChatCoreV2CapabilityEnabled>[1];

const TASKS_TODAY_SUMMARY_CAPABILITY = 'tasks.today_summary';
const MAX_VISIBLE_TASKS = 5;

export function tryBuildChatCoreV2DeterministicReadRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
): ChatCoreV2DeterministicReadRouteResult | null {
  const text = input.normalizedText.trim();
  if (!text) return null;

  const scope: RuntimeFlagScope = { userId: input.userId, tenantId: input.tenantId };
  const flagInput: ChatCoreV2CapabilityFlagInput = {
    env: input.env ?? process.env,
    scope,
  };
  if (!isChatCoreV2CapabilityEnabled(TASKS_TODAY_SUMMARY_CAPABILITY, flagInput)) {
    return null;
  }

  const routeGuess = classifyShadowRoute(text);
  if (
    routeGuess.intent !== 'app_question'
    || !routeGuess.capabilityIds.includes(TASKS_TODAY_SUMMARY_CAPABILITY)
    || routeGuess.domains.some((domain) => domain !== 'tasks')
  ) {
    return null;
  }

  const now = input.now ?? new Date();
  const timezone = normalizeTimezone(input.timezone);
  const pendingTasks = listTasks(input.userId, { status: 'pending' });
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

function buildTaskSummaryHeader(data: ChatCoreV2TaskSummaryData, locale: ReturnType<typeof normalizeChatCoreV2Locale>): string {
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
  locale: ReturnType<typeof normalizeChatCoreV2Locale>,
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

function taskListLabel(locale: ReturnType<typeof normalizeChatCoreV2Locale>): string {
  if (locale === 'pt-BR') return 'Principais tarefas:';
  if (locale === 'pt-PT') return 'Tarefas principais:';
  if (locale === 'es') return 'Tareas principales:';
  return 'Top tasks:';
}

function taskSuffix(task: ChatCoreV2TaskSummaryItem, locale: ReturnType<typeof normalizeChatCoreV2Locale>): string {
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

function joinParts(parts: string[], locale: ReturnType<typeof normalizeChatCoreV2Locale>): string {
  if (parts.length === 1) return parts[0];
  const andWord = locale === 'en' ? 'and' : locale === 'es' ? 'y' : 'e';
  return `${parts.slice(0, -1).join(', ')} ${andWord} ${parts[parts.length - 1]}`;
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
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

function normalizeTimezone(value: string | null | undefined): string {
  const timezone = String(value ?? '').trim();
  return timezone || 'UTC';
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}
