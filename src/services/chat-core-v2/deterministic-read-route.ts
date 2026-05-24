// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';

import { getDecisionSummary, type DecisionApiItem, type DecisionSummary } from '../decision-center';
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

export type ChatCoreV2DeterministicReadCapabilityId =
  | 'tasks.today_summary'
  | 'decision_center.summary';

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

export interface ChatCoreV2DecisionCenterSummaryItem {
  entityId: string;
  title: string;
  sourceSkill: string;
  urgency: string;
  status: string;
  actionLabel: string | null;
  why: string | null;
}

export interface ChatCoreV2DecisionCenterSummaryData {
  openCount: number;
  urgentCount: number;
  todayCount: number;
  handledTodayCount: number;
  badgeCount: number;
  ctaLabel: string;
  topDecisionTitle: string | null;
  topDecisionWhy: string | null;
  topSuggestionTitle: string | null;
  topItems: ChatCoreV2DecisionCenterSummaryItem[];
}

export type ChatCoreV2DeterministicReadData =
  | ChatCoreV2TaskSummaryData
  | ChatCoreV2DecisionCenterSummaryData;

export interface ChatCoreV2DeterministicReadRouteResult {
  capabilityId: ChatCoreV2DeterministicReadCapabilityId;
  routeGuess: ChatCoreV2ShadowRouteGuess;
  readModel: ChatCoreV2ReadModelResult<ChatCoreV2DeterministicReadData>;
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
const DECISION_CENTER_SUMMARY_CAPABILITY = 'decision_center.summary';
const MAX_VISIBLE_TASKS = 5;
const MAX_VISIBLE_DECISIONS = 3;

export function tryBuildChatCoreV2DeterministicReadRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
): ChatCoreV2DeterministicReadRouteResult | null {
  const text = input.normalizedText.trim();
  if (!text) return null;

  const routeGuess = classifyShadowRoute(text);
  const capabilityId = deterministicReadCapabilityForRouteGuess(routeGuess);
  if (!capabilityId) return null;

  const scope: RuntimeFlagScope = { userId: input.userId, tenantId: input.tenantId };
  const flagInput: ChatCoreV2CapabilityFlagInput = {
    env: input.env ?? process.env,
    scope,
  };
  if (!isChatCoreV2CapabilityEnabled(capabilityId, flagInput)) {
    return null;
  }

  if (capabilityId === DECISION_CENTER_SUMMARY_CAPABILITY) {
    return buildDecisionCenterSummaryRoute(input, routeGuess);
  }
  return buildTaskSummaryRoute(input, routeGuess);
}

function deterministicReadCapabilityForRouteGuess(
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2DeterministicReadCapabilityId | null {
  if (routeGuess.intent !== 'app_question') return null;
  if (routeGuess.domains.length !== 1) return null;
  if (routeGuess.domains[0] === 'tasks' && routeGuess.capabilityIds.includes(TASKS_TODAY_SUMMARY_CAPABILITY)) {
    return TASKS_TODAY_SUMMARY_CAPABILITY;
  }
  if (routeGuess.domains[0] === 'decision_center' && routeGuess.capabilityIds.includes(DECISION_CENTER_SUMMARY_CAPABILITY)) {
    return DECISION_CENTER_SUMMARY_CAPABILITY;
  }
  return null;
}

function buildTaskSummaryRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2DeterministicReadRouteResult | null {
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

function buildDecisionCenterSummaryRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2DeterministicReadRouteResult | null {
  const now = input.now ?? new Date();
  const summary = getDecisionSummary(input.userId, input.tenantId, MAX_VISIBLE_DECISIONS);
  const data = summarizeDecisionCenter(summary);
  const readModel = buildChatCoreV2ReadModelResult<ChatCoreV2DecisionCenterSummaryData>({
    capabilityId: DECISION_CENTER_SUMMARY_CAPABILITY,
    domain: 'decision_center',
    data,
    sourceEntityIds: data.topItems.map((item) => item.entityId),
    sourceVersions: sourceVersionsForDecisions(summary.previewItems),
    generatedAt: now.toISOString(),
    maxSourceAgeSeconds: 60,
    sensitivity: 'personal',
    summary: buildDecisionCenterSummaryText(data, input.locale),
    locale: normalizeChatCoreV2Locale(input.locale),
    now,
  });
  if (!isReadModelFreshEnough(readModel)) return null;

  const contextPack = buildChatCoreV2ReadContextPack([readModel], { generatedAt: now.toISOString() });
  const response = buildChatCoreV2MessageResponse({
    text: readModel.summary ?? buildDecisionCenterSummaryText(data, input.locale),
    locale: input.locale,
    reasonCodes: ['deterministic_read', DECISION_CENTER_SUMMARY_CAPABILITY],
  });

  return {
    capabilityId: DECISION_CENTER_SUMMARY_CAPABILITY,
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

function summarizeDecisionCenter(summary: DecisionSummary): ChatCoreV2DecisionCenterSummaryData {
  return {
    openCount: summary.openCount,
    urgentCount: summary.urgentCount,
    todayCount: summary.todayCount,
    handledTodayCount: summary.handledTodayCount,
    badgeCount: summary.badgeCount,
    ctaLabel: summary.ctaLabel,
    topDecisionTitle: summary.topDecisionTitle,
    topDecisionWhy: summary.topDecisionWhy,
    topSuggestionTitle: summary.topSuggestion?.title ?? null,
    topItems: summary.previewItems.slice(0, MAX_VISIBLE_DECISIONS).map((item) => ({
      entityId: decisionEntityId(item),
      title: item.safePreviewTitle || item.title,
      sourceSkill: item.sourceSkill,
      urgency: item.urgency,
      status: item.status,
      actionLabel: item.explanation?.actionLabels?.primary ?? item.primaryActionLabel ?? item.recommendedActionLabel,
      why: item.explanation?.whyItMatters ?? item.whySummary ?? item.analysis?.whyNow ?? null,
    })),
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

function buildDecisionCenterSummaryText(
  data: ChatCoreV2DecisionCenterSummaryData,
  locale: string | null | undefined,
): string {
  const normalizedLocale = normalizeChatCoreV2Locale(locale);
  if (data.openCount === 0) {
    if (normalizedLocale === 'pt-BR') return 'O Decision Center está sem pendências agora.';
    if (normalizedLocale === 'pt-PT') return 'O Decision Center não tem pendências neste momento.';
    if (normalizedLocale === 'es') return 'El Decision Center está al día ahora.';
    return 'Decision Center is clear right now.';
  }

  const header = buildDecisionCenterSummaryHeader(data, normalizedLocale);
  if (data.topItems.length === 0) return header;
  const itemLines = data.topItems.map((item) => {
    const action = item.actionLabel ? decisionActionSuffix(item.actionLabel, normalizedLocale) : '';
    return `- ${item.title}${decisionUrgencySuffix(item.urgency, normalizedLocale)}${action}`;
  });
  return `${header}\n\n${decisionListLabel(normalizedLocale)}\n${itemLines.join('\n')}`;
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

function buildDecisionCenterSummaryHeader(
  data: ChatCoreV2DecisionCenterSummaryData,
  locale: ReturnType<typeof normalizeChatCoreV2Locale>,
): string {
  const parts: string[] = [];
  if (data.urgentCount > 0) parts.push(decisionCountPhrase(data.urgentCount, locale, 'urgent'));
  if (data.todayCount > 0) parts.push(decisionCountPhrase(data.todayCount, locale, 'today'));
  if (data.handledTodayCount > 0) parts.push(decisionCountPhrase(data.handledTodayCount, locale, 'handled'));
  const detail = parts.length > 0 ? ` ${joinParts(parts, locale)}` : '';
  if (locale === 'pt-BR') return `O Decision Center tem ${data.openCount} ${plural(data.openCount, 'decisão aberta', 'decisões abertas')}.${detail}`;
  if (locale === 'pt-PT') return `O Decision Center tem ${data.openCount} ${plural(data.openCount, 'decisão aberta', 'decisões abertas')}.${detail}`;
  if (locale === 'es') return `Decision Center tiene ${data.openCount} ${plural(data.openCount, 'decisión abierta', 'decisiones abiertas')}.${detail}`;
  return `Decision Center has ${data.openCount} open ${data.openCount === 1 ? 'decision' : 'decisions'}.${detail}`;
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

function decisionCountPhrase(
  count: number,
  locale: ReturnType<typeof normalizeChatCoreV2Locale>,
  kind: 'urgent' | 'today' | 'handled',
): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') {
    if (kind === 'urgent') return `${count} ${plural(count, 'urgente', 'urgentes')}`;
    if (kind === 'today') return `${count} ${plural(count, 'para hoje', 'para hoje')}`;
    return `${count} ${plural(count, 'tratada hoje', 'tratadas hoje')}`;
  }
  if (locale === 'es') {
    if (kind === 'urgent') return `${count} ${plural(count, 'urgente', 'urgentes')}`;
    if (kind === 'today') return `${count} ${plural(count, 'para hoy', 'para hoy')}`;
    return `${count} ${plural(count, 'gestionada hoy', 'gestionadas hoy')}`;
  }
  if (kind === 'urgent') return `${count} urgent`;
  if (kind === 'today') return `${count} for today`;
  return `${count} handled today`;
}

function taskListLabel(locale: ReturnType<typeof normalizeChatCoreV2Locale>): string {
  if (locale === 'pt-BR') return 'Principais tarefas:';
  if (locale === 'pt-PT') return 'Tarefas principais:';
  if (locale === 'es') return 'Tareas principales:';
  return 'Top tasks:';
}

function decisionListLabel(locale: ReturnType<typeof normalizeChatCoreV2Locale>): string {
  if (locale === 'pt-BR') return 'Principais decisões:';
  if (locale === 'pt-PT') return 'Decisões principais:';
  if (locale === 'es') return 'Decisiones principales:';
  return 'Top decisions:';
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

function decisionUrgencySuffix(urgency: string, locale: ReturnType<typeof normalizeChatCoreV2Locale>): string {
  if (urgency === 'urgent') {
    if (locale === 'pt-BR' || locale === 'pt-PT') return ' (urgente)';
    if (locale === 'es') return ' (urgente)';
    return ' (urgent)';
  }
  if (urgency === 'today') {
    if (locale === 'pt-BR' || locale === 'pt-PT') return ' (hoje)';
    if (locale === 'es') return ' (hoy)';
    return ' (today)';
  }
  return '';
}

function decisionActionSuffix(actionLabel: string, locale: ReturnType<typeof normalizeChatCoreV2Locale>): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') return ` - precisa de: ${actionLabel}`;
  if (locale === 'es') return ` - necesita: ${actionLabel}`;
  return ` - needs: ${actionLabel}`;
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

function sourceVersionsForDecisions(items: DecisionApiItem[]): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const item of items) {
    versions[decisionEntityId(item)] = hashStable({
      status: item.status,
      urgency: item.urgency,
      title: item.safePreviewTitle || item.title,
      actionLabel: item.explanation?.actionLabels?.primary ?? item.primaryActionLabel ?? item.recommendedActionLabel,
      updatedAt: item.updatedAt,
      snoozedUntil: item.snoozedUntil,
    });
  }
  return versions;
}

function taskEntityId(task: NormalizedTask): string {
  if (typeof task.id === 'number' && Number.isFinite(task.id)) return `task:${task.id}`;
  return `task:${hashStable({ provider: task.provider, externalId: task.externalId }).slice(0, 12)}`;
}

function decisionEntityId(item: DecisionApiItem): string {
  return `decision:${item.decisionId}`;
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
