// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Microsoft To Do adapter for the unified/offline-first task store.
 *
 * The legacy task routes can read Microsoft Graph directly, but the iOS Tasks
 * surface reads from `unified_tasks`. This adapter lets the scheduler import
 * connected Outlook / Microsoft To Do accounts into that local read model.
 */

import { Client } from '@microsoft/microsoft-graph-client';
import { logger } from '../../utils/logger';
import { isConnected } from '../oauth-store';
import { getGraphClientForUser } from '../microsoft-auth';
import { config } from '../../config';
import type { TaskProviderAdapter } from './adapter-interface';
import type { NormalizedChecklistItem, NormalizedProject, NormalizedStatus, NormalizedTask } from './types';

type GraphTodoList = {
  id?: string;
  displayName?: string;
  isOwner?: boolean;
  isShared?: boolean;
  wellknownListName?: string;
};

type GraphTodoTask = {
  id?: string;
  title?: string;
  body?: { content?: string };
  importance?: string;
  status?: string;
  dueDateTime?: { dateTime?: string; timeZone?: string };
  reminderDateTime?: { dateTime?: string; timeZone?: string };
  createdDateTime?: string;
  completedDateTime?: { dateTime?: string; timeZone?: string } | string;
  recurrence?: unknown;
  checklistItems?: Array<{ id?: string; displayName?: string; isChecked?: boolean }>;
  linkedResources?: Array<{ applicationName?: string; externalId?: string; displayName?: string }>;
  lastModifiedDateTime?: string;
  updatedDateTime?: string;
  '@odata.etag'?: string;
  etag?: string;
  eTag?: string;
};

type ResolvedGraphTask = {
  list: NormalizedProject;
  task: GraphTodoTask;
};

const MS_GRAPH_PAGE_SIZE = 100;
const DEFAULT_MS_GRAPH_REQUEST_TIMEOUT_MS = 15_000;

function microsoftGraphRequestTimeoutMs(): number {
  const parsed = Number(process.env.MS_TODO_GRAPH_REQUEST_TIMEOUT_MS || '');
  if (Number.isFinite(parsed) && parsed >= 1000) return Math.floor(parsed);
  return DEFAULT_MS_GRAPH_REQUEST_TIMEOUT_MS;
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = microsoftGraphRequestTimeoutMs()): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out`);
      (err as any).code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeMsGraphDateTime(dt?: { dateTime?: string; timeZone?: string } | string): string | undefined {
  if (!dt) return undefined;
  if (typeof dt === 'string') return dt || undefined;
  if (!dt.dateTime) return undefined;

  let normalized = dt.dateTime.replace(/\.\d+/, '');
  if ((!dt.timeZone || dt.timeZone === 'UTC') && !/[Zz]$|[+-]\d{2}:?\d{2}$/.test(normalized)) {
    normalized += 'Z';
  }
  return normalized;
}

function graphStatusToNexus(value: unknown): NormalizedStatus {
  switch (String(value || '').trim().toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'inprogress':
    case 'in_progress':
      return 'in_progress';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

function nexusStatusToGraph(value: unknown): string | undefined {
  switch (String(value || '').trim().toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'in_progress':
    case 'inprogress':
      return 'inProgress';
    case 'pending':
    case 'notstarted':
      return 'notStarted';
    default:
      return undefined;
  }
}

function graphImportanceToPriority(value: unknown): number {
  switch (String(value || '').trim().toLowerCase()) {
    case 'high':
      return 3;
    case 'low':
      return 1;
    case 'normal':
      return 2;
    default:
      return 0;
  }
}

function priorityToGraphImportance(value: unknown): 'low' | 'normal' | 'high' | undefined {
  const priority = Number(value);
  if (!Number.isFinite(priority)) return undefined;
  if (priority >= 3) return 'high';
  if (priority === 1) return 'low';
  if (priority === 2) return 'normal';
  return undefined;
}

function normalizeChecklistItems(value: GraphTodoTask['checklistItems']): NormalizedChecklistItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => {
      const id = String(item.id || '').trim();
      const displayName = String(item.displayName || '').trim();
      if (!id || !displayName) return null;
      return {
        id,
        displayName,
        isChecked: item.isChecked ?? false,
      };
    })
    .filter((item): item is NormalizedChecklistItem => item != null);
  return items.length > 0 ? items : undefined;
}

function projectFromGraphList(list: GraphTodoList): NormalizedProject {
  return {
    provider: 'ms_todo',
    externalId: String(list.id || ''),
    name: String(list.displayName || '(Unnamed)').trim() || '(Unnamed)',
    isDefault: list.wellknownListName === 'defaultList',
    taskCount: 0,
  };
}

function taskProviderData(task: GraphTodoTask, list: NormalizedProject): Record<string, unknown> {
  return {
    ...task,
    listId: list.externalId,
    listName: list.name,
    etag: task['@odata.etag'] || task.etag || task.eTag,
  };
}

function taskFromGraphTask(task: GraphTodoTask, list: NormalizedProject): NormalizedTask {
  const dueDate = normalizeMsGraphDateTime(task.dueDateTime);
  return {
    provider: 'ms_todo',
    externalId: String(task.id || ''),
    projectName: list.name,
    title: String(task.title || '(Untitled)').trim() || '(Untitled)',
    description: task.body?.content || undefined,
    notes: task.body?.content || undefined,
    status: graphStatusToNexus(task.status),
    priority: graphImportanceToPriority(task.importance),
    dueDate,
    dueIsDatetime: !!dueDate && dueDate.includes('T'),
    completedAt: normalizeMsGraphDateTime(task.completedDateTime),
    recurrence: task.recurrence,
    checklistItems: normalizeChecklistItems(task.checklistItems),
    providerData: taskProviderData(task, list),
  };
}

function graphTaskBodyFromNormalized(task: Partial<NormalizedTask>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (task.title !== undefined) body.title = task.title || '(Untitled)';
  if (task.description !== undefined || task.notes !== undefined) {
    body.body = {
      content: task.description ?? task.notes ?? '',
      contentType: 'text',
    };
  }
  const importance = priorityToGraphImportance(task.priority);
  if (importance) body.importance = importance;
  const status = nexusStatusToGraph(task.status);
  if (status) body.status = status;
  if (task.dueDate !== undefined) {
    body.dueDateTime = task.dueDate
      ? { dateTime: task.dueDate, timeZone: config.app.timezone }
      : null;
  }
  if (task.recurrence !== undefined) body.recurrence = task.recurrence || null;
  return body;
}

function extractProviderListId(task: Partial<NormalizedTask>): string | null {
  const candidates = [
    task.providerData?.listId,
    task.providerData?.list_id,
    task.providerData?.projectId,
    task.providerData?.project_id,
  ];
  for (const candidate of candidates) {
    if (candidate != null && String(candidate).trim()) return String(candidate).trim();
  }
  return null;
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 1): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(fn(), 'Microsoft To Do Graph request');
    } catch (err: any) {
      const status = Number(err?.statusCode || err?.status || err?.code || err?.response?.status);
      const retryable = status === 429 || status === 503;
      if (!retryable || attempt === maxRetries) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 10000);
      logger.warn({ attempt, delay, status }, 'Retrying Microsoft To Do adapter Graph call');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('Unreachable');
}

async function graphGetPaged<T>(client: Client, path: string, query?: Record<string, string>): Promise<T[]> {
  const rows: T[] = [];
  let request = client.api(path);
  if (query) request = request.query(query);
  let response = await withRetry(() => request.get());
  rows.push(...(response.value || []));

  while (response['@odata.nextLink']) {
    response = await withRetry(() => client.api(response['@odata.nextLink']).get());
    rows.push(...(response.value || []));
  }

  return rows;
}

export class MicrosoftTodoAdapter implements TaskProviderAdapter {
  readonly provider = 'ms_todo' as const;

  readonly capabilities = {
    canCreate: true,
    canComplete: true,
    canDelete: true,
    canUpdate: true,
    canAssignDue: true,
    hasWebhooks: false,
    hasIncrementalSync: false,
  };

  isConnected(userId: number): boolean {
    return isConnected(userId, 'outlook');
  }

  async getProjects(userId: number): Promise<NormalizedProject[]> {
    const client = getGraphClientForUser(userId);
    const lists = await graphGetPaged<GraphTodoList>(client, '/me/todo/lists');
    return lists
      .filter((list) => String(list.id || '').trim())
      .map(projectFromGraphList);
  }

  async getTasks(
    userId: number,
    options?: { projectId?: string },
  ): Promise<{ tasks: NormalizedTask[]; nextCursor?: string }> {
    const projects = options?.projectId
      ? (await this.getProjects(userId)).filter((project) => project.externalId === options.projectId)
      : await this.getProjects(userId);
    const client = getGraphClientForUser(userId);
    const tasks: NormalizedTask[] = [];

    for (const project of projects) {
      try {
        const rawTasks = await graphGetPaged<GraphTodoTask>(
          client,
          `/me/todo/lists/${encodeURIComponent(project.externalId)}/tasks`,
          {
            $top: String(MS_GRAPH_PAGE_SIZE),
            $orderby: 'createdDateTime DESC',
            $expand: 'checklistItems,linkedResources',
          },
        );
        tasks.push(
          ...rawTasks
            .filter((task) => String(task.id || '').trim())
            .map((task) => taskFromGraphTask(task, project)),
        );
      } catch (err) {
        logger.warn({ err, userId, listId: project.externalId }, 'Microsoft To Do adapter failed to fetch list tasks');
      }
    }

    return { tasks };
  }

  async createTask(
    userId: number,
    task: Omit<NormalizedTask, 'id' | 'provider' | 'externalId'>,
  ): Promise<NormalizedTask> {
    const project = await this.resolveProjectForWrite(userId, task);
    const client = getGraphClientForUser(userId);
    const body = graphTaskBodyFromNormalized(task);
    if (!body.title) body.title = task.title || '(Untitled)';
    const response = await withRetry(() =>
      client.api(`/me/todo/lists/${encodeURIComponent(project.externalId)}/tasks`).post(body),
    );
    return taskFromGraphTask(response, project);
  }

  async completeTask(userId: number, externalId: string): Promise<void> {
    await this.updateTask(userId, externalId, { status: 'completed' });
  }

  async deleteTask(userId: number, externalId: string): Promise<void> {
    const found = await this.findTask(userId, externalId);
    const client = getGraphClientForUser(userId);
    await withRetry(() =>
      client.api(`/me/todo/lists/${encodeURIComponent(found.list.externalId)}/tasks/${encodeURIComponent(externalId)}`).delete(),
    );
  }

  async updateTask(
    userId: number,
    externalId: string,
    updates: Partial<NormalizedTask>,
  ): Promise<void> {
    const found = await this.findTask(userId, externalId);
    const client = getGraphClientForUser(userId);
    const body = graphTaskBodyFromNormalized(updates);
    if (Object.keys(body).length === 0) return;
    await withRetry(() =>
      client.api(`/me/todo/lists/${encodeURIComponent(found.list.externalId)}/tasks/${encodeURIComponent(externalId)}`).patch(body),
    );
  }

  private async resolveProjectForWrite(userId: number, task: Partial<NormalizedTask>): Promise<NormalizedProject> {
    const projects = await this.getProjects(userId);
    const providerListId = extractProviderListId(task);
    const byId = providerListId ? projects.find((project) => project.externalId === providerListId) : null;
    if (byId) return byId;

    const projectName = String(task.projectName || '').trim().toLowerCase();
    const byName = projectName ? projects.find((project) => project.name.toLowerCase() === projectName) : null;
    if (byName) return byName;

    const fallback = projects.find((project) => project.isDefault) || projects[0];
    if (!fallback) throw new Error('Microsoft To Do has no lists for this user');
    return fallback;
  }

  private async findTask(userId: number, externalId: string): Promise<ResolvedGraphTask> {
    const projects = await this.getProjects(userId);
    const client = getGraphClientForUser(userId);
    for (const project of projects) {
      try {
        const task = await withRetry(() =>
          client.api(`/me/todo/lists/${encodeURIComponent(project.externalId)}/tasks/${encodeURIComponent(externalId)}`)
            .query({ $expand: 'checklistItems,linkedResources' })
            .get(),
        );
        if (task?.id) return { list: project, task };
      } catch (err: any) {
        const status = Number(err?.statusCode || err?.status || err?.code || err?.response?.status);
        if (status !== 404) {
          logger.warn({ err, userId, listId: project.externalId }, 'Microsoft To Do adapter task lookup failed for list');
        }
      }
    }
    throw new Error('Microsoft To Do task not found');
  }
}

export const __testing = {
  graphImportanceToPriority,
  graphStatusToNexus,
  normalizeMsGraphDateTime,
  projectFromGraphList,
  taskFromGraphTask,
  withTimeout,
};
