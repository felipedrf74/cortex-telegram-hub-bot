// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getGraphClient, isMicrosoftConfigured } from './microsoft-auth';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  expandRecurringTaskOccurrencesForRange,
  realignMicrosoftRecurrenceForDueDate,
  type NormalizedRecurrence,
} from './recurrence-utils';

// ─── Types ──────────────────────────────────────────────────────────

export interface TodoList {
  id: string;
  displayName: string;
  isOwner: boolean;
  isShared: boolean;
  /**
   * Microsoft Graph returns this field on system-managed lists. The user's
   * primary tasks list (the one MS To Do auto-creates) has the value
   * `'defaultList'` regardless of locale — so a German user's "Aufgaben",
   * a Portuguese user's "Tarefas", and an English user's "Tasks" all share
   * the same `wellknownListName: 'defaultList'`. Use this for locale-safe
   * default-list discovery before falling back to displayName matching.
   */
  wellknownListName?: string;
}

export interface TodoTask {
  id: string;
  listId: string;
  listName: string;
  title: string;
  body?: string;
  importance: 'low' | 'normal' | 'high';
  status: 'notStarted' | 'inProgress' | 'completed' | 'waitingOnOthers' | 'deferred';
  dueDateTime?: string;
  reminderDateTime?: string;
  isReminderOn: boolean;
  createdDateTime: string;
  completedDateTime?: string;
  checklistItems?: ChecklistItem[];
  recurrence?: NormalizedRecurrence;
  providerVersion?: string;
  providerUpdatedAt?: string;
  linkedResources?: Array<{ applicationName?: string; externalId?: string; displayName?: string }>;
  providerData?: Record<string, unknown>;
}

export interface ChecklistItem {
  id: string;
  displayName: string;
  isChecked: boolean;
}

export interface ServiceResult<T = any> {
  success: boolean;
  data: T;
  error?: string;
  statusCode?: number;
}

// Auth is handled by shared microsoft-auth.ts module

export function isOutlookTodoConfigured(): boolean {
  return isMicrosoftConfigured();
}

// ─── Retry Helper ───────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.statusCode || err?.code;
      const isRetryable = status === 429 || status === 503;

      if (!isRetryable || attempt === maxRetries) throw err;

      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      logger.warn({ attempt, delay, status }, 'Retrying Microsoft To Do API call');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

function withIfMatch(request: any, ifMatch?: string): any {
  if (!ifMatch) return request;
  if (typeof request.header === 'function') return request.header('If-Match', ifMatch);
  if (typeof request.headers === 'function') return request.headers({ 'If-Match': ifMatch });
  return request;
}

function graphStatusCode(err: unknown): number | undefined {
  const candidates = [
    (err as any)?.statusCode,
    (err as any)?.status,
    (err as any)?.code,
    (err as any)?.response?.status,
    (err as any)?.response?.statusCode,
  ];
  for (const candidate of candidates) {
    const statusCode = Number(candidate);
    if (Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) return statusCode;
  }
  return undefined;
}

// ─── Helper: Parse Graph API task to our format ─────────────────────

/**
 * Normalize MS Graph dateTimeTimeZone objects to a clean ISO 8601 UTC string.
 *
 * MS Graph returns due/reminder dates as { dateTime, timeZone } where dateTime
 * is missing the trailing "Z" and uses 7 fractional second digits, e.g.:
 *   { dateTime: "2026-04-05T23:00:00.0000000", timeZone: "UTC" }
 *
 * Without normalization, JavaScript's `new Date()` interprets the bare string
 * as **local time** — on a server in any timezone other than UTC, this is off
 * by the local UTC offset (e.g. "2026-04-05T23:00:00" → April 5 23:00 LISBON
 * instead of UTC), which causes today's tasks to be misclassified as overdue.
 *
 * Apple's ISO8601DateFormatter also rejects 7 fractional second digits.
 *
 * This helper:
 *   1) Strips the (non-standard) fractional seconds entirely
 *   2) Appends "Z" if the source timezone is UTC (the MS Graph default)
 *   3) Falls back to the raw value for non-UTC timezones (rare)
 */
function normalizeMsGraphDateTime(dt?: { dateTime?: string; timeZone?: string }): string | undefined {
  if (!dt?.dateTime) return undefined;
  // Drop fractional seconds — they're non-standard width and never meaningful
  // for due dates (which are date-only or hour-precision in practice).
  let normalized = dt.dateTime.replace(/\.\d+/, '');
  // If the source timezone is UTC (MS Graph default for /me/todo), mark it.
  // For any other timezone, leave the string as-is and let consumers handle it.
  if ((!dt.timeZone || dt.timeZone === 'UTC') && !/[Zz]$|[+-]\d{2}:?\d{2}$/.test(normalized)) {
    normalized += 'Z';
  }
  return normalized;
}

function parseTask(task: any, listId: string, listName: string): TodoTask {
  return {
    id: task.id || '',
    listId,
    listName,
    title: task.title || '(Untitled)',
    body: task.body?.content || undefined,
    importance: task.importance || 'normal',
    status: task.status || 'notStarted',
    dueDateTime: normalizeMsGraphDateTime(task.dueDateTime),
    reminderDateTime: normalizeMsGraphDateTime(task.reminderDateTime),
    isReminderOn: task.isReminderOn || false,
    createdDateTime: task.createdDateTime || '',
    completedDateTime: normalizeMsGraphDateTime(task.completedDateTime),
    recurrence: task.recurrence,
    providerVersion: task['@odata.etag'] || task.etag || task.eTag,
    providerUpdatedAt: task.lastModifiedDateTime || task.updatedDateTime,
    linkedResources: Array.isArray(task.linkedResources)
      ? task.linkedResources.map((resource: any) => ({
          applicationName: resource.applicationName,
          externalId: resource.externalId,
          displayName: resource.displayName,
        }))
      : undefined,
    providerData: task,
    // TASK-M8: include checklist items from the $expand=checklistItems response
    checklistItems: Array.isArray(task.checklistItems)
      ? task.checklistItems.map((ci: any) => ({
          id: ci.id || '',
          displayName: ci.displayName || '',
          isChecked: ci.isChecked ?? false,
        }))
      : undefined,
  };
}

// ─── Self-created task tracking (to filter out own tasks in shared list notifications) ──

const selfCreatedTaskIds = new Set<string>();

/** Check if a task was created by us (via this bot) */
export function isSelfCreatedTask(taskId: string): boolean {
  return selfCreatedTaskIds.has(taskId);
}

/** Clear self-created tracking (called daily by scheduler) */
export function clearSelfCreatedTasks(): void {
  selfCreatedTaskIds.clear();
}

// ─── List Cache (5-min TTL) ─────────────────────────────────────────

// Per-user list cache keyed by userId (or 'owner' for the singleton)
const listCacheMap = new Map<string, { lists: TodoList[]; at: number }>();
const LIST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getListCacheKey(): string {
  try {
    const { getCurrentContext } = require('../utils/request-context');
    const ctx = getCurrentContext();
    return ctx?.userId ? `user:${ctx.userId}` : 'owner';
  } catch { return 'owner'; }
}

export function invalidateListCache(): void {
  const key = getListCacheKey();
  listCacheMap.delete(key);
}

// Legacy compat — access cached lists for the current user
function getCachedLists(): TodoList[] | null {
  const key = getListCacheKey();
  const entry = listCacheMap.get(key);
  if (!entry || Date.now() - entry.at > LIST_CACHE_TTL) return null;
  return entry.lists;
}

function setCachedLists(lists: TodoList[]): void {
  listCacheMap.set(getListCacheKey(), { lists, at: Date.now() });
}

// ─── Task Lists ─────────────────────────────────────────────────────

export async function getLists(): Promise<ServiceResult<TodoList[]>> {
  try {
    // Return cached lists if fresh (per-user cache)
    const cached = getCachedLists();
    if (cached) {
      return { success: true, data: cached };
    }

    const client = getGraphClient();
    const response = await withRetry(() =>
      client.api('/me/todo/lists').get()
    );

    const lists: TodoList[] = (response.value || []).map((list: any) => ({
      id: list.id || '',
      displayName: list.displayName || '(Unnamed)',
      isOwner: list.isOwner ?? true,
      isShared: list.isShared ?? false,
      // wellknownListName is only present on system-managed lists; the
      // primary tasks folder reports `'defaultList'` here regardless of locale.
      wellknownListName: list.wellknownListName || undefined,
    }));

    setCachedLists(lists);

    return { success: true, data: lists };
  } catch (err) {
    logger.error({ err }, 'Failed to fetch To Do lists');
    return { success: false, data: [], error: (err as Error).message };
  }
}

export async function createList(displayName: string): Promise<ServiceResult<TodoList>> {
  try {
    const client = getGraphClient();
    const response = await withRetry(() =>
      client.api('/me/todo/lists').post({ displayName })
    );

    invalidateListCache();
    return {
      success: true,
      data: {
        id: response.id,
        displayName: response.displayName,
        isOwner: true,
        isShared: false,
      },
    };
  } catch (err) {
    logger.error({ err }, 'Failed to create To Do list');
    return { success: false, data: null as any, error: (err as Error).message };
  }
}

export async function updateList(listId: string, displayName: string): Promise<ServiceResult<TodoList>> {
  try {
    const client = getGraphClient();
    const response = await withRetry(() =>
      client.api(`/me/todo/lists/${listId}`).patch({ displayName })
    );

    return {
      success: true,
      data: {
        id: response.id,
        displayName: response.displayName,
        isOwner: response.isOwner ?? true,
        isShared: response.isShared ?? false,
      },
    };
  } catch (err) {
    logger.error({ err }, 'Failed to update To Do list');
    return { success: false, data: null as any, error: (err as Error).message };
  }
}

export async function deleteList(listId: string): Promise<ServiceResult<void>> {
  try {
    const client = getGraphClient();
    await withRetry(() =>
      client.api(`/me/todo/lists/${listId}`).delete()
    );
    invalidateListCache();
    return { success: true, data: undefined };
  } catch (err) {
    logger.error({ err }, 'Failed to delete To Do list');
    return { success: false, data: undefined, error: (err as Error).message };
  }
}

/**
 * Find a list by name (case-insensitive).
 * Returns the first match or null.
 */
export async function findListByName(name: string): Promise<TodoList | null> {
  const result = await getLists();
  if (!result.success) return null;

  const lower = name.toLowerCase();
  return result.data.find((l) => l.displayName.toLowerCase() === lower)
    || result.data.find((l) => l.displayName.toLowerCase().includes(lower))
    || null;
}

/**
 * Locale-aware names for the user's default tasks list. Microsoft To Do
 * auto-creates this list on first use and localizes the name to the user's
 * Outlook display language. We try these in order when the configured name
 * doesn't match and the wellknownListName lookup also fails.
 *
 * Add more entries here as users in new locales report mismatches.
 */
const LOCALIZED_DEFAULT_NAMES = [
  'Tasks',           // English
  'Tarefas',         // Portuguese (PT/BR)
  'Tareas',          // Spanish
  'Tâches',          // French
  'Aufgaben',        // German
  'Attività',        // Italian
  'Taken',           // Dutch
  'Uppgifter',       // Swedish
  'Opgaver',         // Danish/Norwegian
  'Tehtävät',        // Finnish
  'Zadania',         // Polish
  'Задачи',          // Russian
  '任务',            // Chinese (Simplified)
  '工作',            // Chinese (Traditional, sometimes)
  'タスク',          // Japanese
  '작업',            // Korean
];

/**
 * Get the user's default tasks list using a 4-tier fallback chain:
 *
 *   1. Configured name from `config.todo.defaultList` (env-overridable, fastest path)
 *   2. Microsoft Graph's `wellknownListName === 'defaultList'` (locale-independent,
 *      this is the canonical answer for any user who hasn't deleted/renamed their
 *      auto-created primary list)
 *   3. Common localized names ('Tarefas', 'Tâches', 'Aufgaben', ...) — handles
 *      users who renamed the primary list to match their UI language
 *   4. The first owned list returned by Graph — final safety net so the chat
 *      `/todo` command never errors with "Default list not found" as long as
 *      the user has at least one list
 *
 * Returns null only if the user literally has zero To Do lists.
 */
export async function getDefaultList(): Promise<TodoList | null> {
  // Tier 1: configured name (existing behavior)
  const configured = await findListByName(config.todo.defaultList);
  if (configured) return configured;

  // Tier 2: locale-independent wellknownListName flag from Graph
  const result = await getLists();
  if (!result.success || result.data.length === 0) return null;

  const wellKnown = result.data.find((l) => l.wellknownListName === 'defaultList');
  if (wellKnown) {
    logger.debug({ list: wellKnown.displayName }, 'Default list resolved via wellknownListName');
    return wellKnown;
  }

  // Tier 3: walk the localized name list
  for (const candidate of LOCALIZED_DEFAULT_NAMES) {
    const lower = candidate.toLowerCase();
    const match = result.data.find((l) => l.displayName.toLowerCase() === lower);
    if (match) {
      logger.debug({ list: match.displayName, candidate }, 'Default list resolved via localized name');
      return match;
    }
  }

  // Tier 4: first owned list (most users have at least one)
  const firstOwned = result.data.find((l) => l.isOwner) || result.data[0];
  if (firstOwned) {
    logger.warn(
      { list: firstOwned.displayName, total: result.data.length },
      'Default list resolved by first-list fallback — consider setting TODO_DEFAULT_LIST',
    );
    return firstOwned;
  }

  return null;
}

// ─── Tasks ──────────────────────────────────────────────────────────

export async function getTasks(
  listId: string,
  listName: string,
  filter?: { status?: string; top?: number; completedAfter?: string }
): Promise<ServiceResult<TodoTask[]>> {
  try {
    const client = getGraphClient();
    let request = client.api(`/me/todo/lists/${listId}/tasks`);

    // NOTE: Do NOT add $select here — Microsoft Graph's OData parser chokes on
    // "title" in $select (RequestBroker--ParseUri / 400 Invalid request).
    // Omitting $select returns all standard fields anyway; the overhead is negligible.
    //
    // TASK-M8: $expand=checklistItems so each task includes its subtask
    // checklist inline — avoids N+1 fetches from the detail view.
    const top = Math.max(1, Math.min(filter?.top || 50, 100));
    const query: Record<string, string> = {
      $orderby: 'createdDateTime DESC',
      $top: String(top),
      $expand: 'checklistItems,linkedResources',
    };

    if (filter?.status) {
      query.$filter = taskStatusFilter(filter.status, filter.completedAfter);
    }

    request = request.query(query);

    const allTasks: TodoTask[] = [];
    let response = await withRetry(() => request.get());
    allTasks.push(...(response.value || []).map((t: any) => parseTask(t, listId, listName)));

    // Handle pagination
    while (response['@odata.nextLink'] && allTasks.length < top) {
      response = await withRetry(() =>
        client.api(response['@odata.nextLink']).get()
      );
      allTasks.push(...(response.value || []).map((t: any) => parseTask(t, listId, listName)));
    }

    return { success: true, data: allTasks.slice(0, top) };
  } catch (err) {
    logger.error({ err, listId }, 'Failed to fetch To Do tasks');
    return { success: false, data: [], error: (err as Error).message };
  }
}

function taskStatusFilter(status: string, completedAfter?: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'active' || normalized === 'pending') {
    return "status ne 'completed'";
  }
  if (normalized === 'completed') {
    const filters = ["status eq 'completed'"];
    if (completedAfter) {
      const bare = completedAfter.replace(/[+-]\d{2}:\d{2}$/, '').replace(/Z$/, '');
      filters.push(`completedDateTime/dateTime ge '${bare}'`);
    }
    return filters.join(' and ');
  }
  return `status eq '${status.replace(/'/g, "''")}'`;
}

export async function getTask(
  listId: string,
  taskId: string,
  listName: string
): Promise<ServiceResult<TodoTask>> {
  try {
    const client = getGraphClient();
    const response = await withRetry(() =>
      client.api(`/me/todo/lists/${listId}/tasks/${taskId}`)
        .query({ $expand: 'checklistItems,linkedResources' })
        .get()
    );

    return { success: true, data: parseTask(response, listId, listName) };
  } catch (err) {
    logger.error({ err, listId, taskId }, 'Failed to fetch To Do task detail');
    return { success: false, data: null as any, error: (err as Error).message };
  }
}

export async function createTask(
  listId: string,
  listName: string,
  data: {
    title: string;
    body?: string;
    importance?: 'low' | 'normal' | 'high';
    dueDateTime?: string;
    reminderDateTime?: string;
    recurrence?: NormalizedRecurrence;
    timeZone?: string;
    nexusTaskId?: string;
  },
  options: { idempotencyKey?: string; nexusTaskId?: string } = {},
): Promise<ServiceResult<TodoTask>> {
  try {
    const client = getGraphClient();
    const tz = data.timeZone || config.app.timezone;

    const taskBody: any = {
      title: data.title,
      importance: data.importance || 'normal',
    };

    if (data.body) {
      taskBody.body = { content: data.body, contentType: 'text' };
    }

    if (data.dueDateTime) {
      taskBody.dueDateTime = { dateTime: data.dueDateTime, timeZone: tz };
    }

    if (data.reminderDateTime) {
      taskBody.reminderDateTime = { dateTime: data.reminderDateTime, timeZone: tz };
      taskBody.isReminderOn = true;
    }

    if (data.recurrence) {
      taskBody.recurrence = data.recurrence;
    }

    const nexusTaskId = options.nexusTaskId || data.nexusTaskId;
    if (nexusTaskId) {
      taskBody.linkedResources = [{
        applicationName: 'NexusHub',
        externalId: nexusTaskId,
        displayName: data.title,
      }];
    }

    const response = await client.api(`/me/todo/lists/${listId}/tasks`).post(taskBody);

    // Track self-created tasks so shared list notifications can filter them out
    if (response.id) selfCreatedTaskIds.add(response.id);

    return { success: true, data: parseTask(response, listId, listName) };
  } catch (err) {
    logger.error({ err, listId }, 'Failed to create To Do task');
    return { success: false, data: null as any, error: (err as Error).message, statusCode: graphStatusCode(err) };
  }
}

export async function updateTask(
  listId: string,
  taskId: string,
  data: {
    title?: string;
    body?: string;
    importance?: 'low' | 'normal' | 'high';
    status?: string;
    dueDateTime?: string | null;
    reminderDateTime?: string | null;
    recurrence?: NormalizedRecurrence | null;
    timeZone?: string;
  },
  listName?: string,
  options: { ifMatch?: string } = {},
): Promise<ServiceResult<TodoTask>> {
  try {
    const client = getGraphClient();
    const tz = data.timeZone || config.app.timezone;
    const patch: any = {};

    if (data.title) patch.title = data.title;
    if (data.body !== undefined) {
      patch.body = { content: data.body || '', contentType: 'text' };
    }
    if (data.importance) patch.importance = data.importance;
    if (data.status) patch.status = data.status;

    if (data.dueDateTime !== undefined) {
      patch.dueDateTime = data.dueDateTime
        ? { dateTime: data.dueDateTime, timeZone: tz }
        : null;
      if (data.dueDateTime) {
        const alignedRecurrence = await recurrenceForMovedDueDate(client, listId, taskId, data.dueDateTime, tz);
        if (alignedRecurrence) {
          patch.recurrence = alignedRecurrence;
        }
      }
    }
    if (data.recurrence !== undefined) {
      patch.recurrence = data.recurrence;
    }

    if (data.recurrence !== undefined) {
      patch.recurrence = data.recurrence || null;
    }

    if (data.reminderDateTime !== undefined) {
      if (data.reminderDateTime) {
        patch.reminderDateTime = { dateTime: data.reminderDateTime, timeZone: tz };
        patch.isReminderOn = true;
      } else {
        patch.reminderDateTime = null;
        patch.isReminderOn = false;
      }
    }

    const response = await withRetry(() => {
      const request = withIfMatch(client.api(`/me/todo/lists/${listId}/tasks/${taskId}`), options.ifMatch);
      return request.patch(patch);
    });

    // Use provided listName, or fall back to cache lookup
    const resolvedName = listName || (await getLists()).data.find((l) => l.id === listId)?.displayName || '';

    return { success: true, data: parseTask(response, listId, resolvedName) };
  } catch (err) {
    logger.error({ err, listId, taskId }, 'Failed to update To Do task');
    return { success: false, data: null as any, error: (err as Error).message, statusCode: graphStatusCode(err) };
  }
}

async function recurrenceForMovedDueDate(
  client: ReturnType<typeof getGraphClient>,
  listId: string,
  taskId: string,
  dueDateTime: string,
  timezone: string,
): Promise<NormalizedRecurrence | undefined> {
  try {
    const current = await withRetry(() =>
      client.api(`/me/todo/lists/${listId}/tasks/${taskId}`).get()
    );
    return realignMicrosoftRecurrenceForDueDate(current?.recurrence, dueDateTime, timezone);
  } catch (err) {
    logger.warn(
      { err, listId, taskId },
      'Could not inspect task recurrence before due date update; continuing without recurrence realignment',
    );
    return undefined;
  }
}

export async function completeTask(
  listId: string,
  taskId: string,
  listName?: string,
  options: { ifMatch?: string } = {},
): Promise<ServiceResult<TodoTask>> {
  return updateTask(listId, taskId, { status: 'completed' }, listName, options);
}

export async function uncompleteTask(
  listId: string,
  taskId: string,
  listName?: string,
  options: { ifMatch?: string } = {},
): Promise<ServiceResult<TodoTask>> {
  return updateTask(listId, taskId, { status: 'notStarted' }, listName, options);
}

export async function deleteTask(listId: string, taskId: string): Promise<ServiceResult<void>> {
  try {
    const client = getGraphClient();
    await withRetry(() =>
      client.api(`/me/todo/lists/${listId}/tasks/${taskId}`).delete()
    );
    return { success: true, data: undefined };
  } catch (err) {
    logger.error({ err, listId, taskId }, 'Failed to delete To Do task');
    return { success: false, data: undefined, error: (err as Error).message, statusCode: graphStatusCode(err) };
  }
}

// ─── Search & Queries ───────────────────────────────────────────────

/**
 * Search tasks across all lists by title keyword.
 * Uses server-side $filter to reduce data transfer.
 */
export async function searchTasks(query: string): Promise<ServiceResult<TodoTask[]>> {
  try {
    const listsResult = await getLists();
    if (!listsResult.success) {
      return { success: false, data: [], error: listsResult.error };
    }

    const client = getGraphClient();
    // Escape single quotes for OData filter
    const escaped = query.replace(/'/g, "''");

    const results = await Promise.all(
      listsResult.data.map(async (list) => {
        try {
          const response = await withRetry(() =>
            client.api(`/me/todo/lists/${list.id}/tasks`)
              .query({ $filter: `contains(title,'${escaped}')`, $top: '50', $expand: 'linkedResources' })
              .get()
          );
          return (response.value || []).map((t: any) => parseTask(t, list.id, list.displayName));
        } catch (err) {
          logger.warn({ err, listId: list.id }, 'searchTasks: failed to search list');
          return [] as TodoTask[];
        }
      })
    );

    const allMatches: TodoTask[] = results.flat();
    return { success: true, data: allMatches };
  } catch (err) {
    logger.error({ err }, 'Failed to search To Do tasks');
    return { success: false, data: [], error: (err as Error).message };
  }
}

/**
 * Get tasks due within a date range (across all lists).
 */
export async function getTasksDueInRange(
  startISO: string,
  endISO: string,
  timezone = config.app.timezone,
): Promise<ServiceResult<TodoTask[]>> {
  try {
    const listsResult = await getLists();
    if (!listsResult.success) {
      return { success: false, data: [], error: listsResult.error };
    }

    const results = await Promise.all(
      listsResult.data.map((list) => getTasks(list.id, list.displayName, { status: 'active' }))
    );

    const tasks: TodoTask[] = [];
    for (const tasksResult of results) {
      if (tasksResult.success) {
        tasks.push(...tasksResult.data);
      }
    }
    const dueTasks = expandRecurringTaskOccurrencesForRange(tasks, startISO, endISO, {
      timezone,
    });

    return { success: true, data: dueTasks };
  } catch (err) {
    logger.error({ err }, 'Failed to get due tasks');
    return { success: false, data: [], error: (err as Error).message };
  }
}

/**
 * Get tasks due within the next N hours (for scheduler notifications).
 */
export async function getTasksDueSoon(hours: number): Promise<ServiceResult<TodoTask[]>> {
  const now = new Date();
  const later = new Date(now.getTime() + hours * 60 * 60 * 1000);
  return getTasksDueInRange(now.toISOString(), later.toISOString());
}

/**
 * Get all pending (not completed) tasks across all lists.
 */
export async function getAllPendingTasks(): Promise<ServiceResult<TodoTask[]>> {
  try {
    const listsResult = await getLists();
    if (!listsResult.success) {
      return { success: false, data: [], error: listsResult.error };
    }

    const results = await Promise.all(
      listsResult.data.map((list) => getTasks(list.id, list.displayName, { status: 'active' }))
    );

    const allPending: TodoTask[] = [];
    for (const tasksResult of results) {
      if (tasksResult.success) {
        allPending.push(...tasksResult.data);
      }
    }

    return { success: true, data: allPending };
  } catch (err) {
    logger.error({ err }, 'Failed to get all pending tasks');
    return { success: false, data: [], error: (err as Error).message };
  }
}

/**
 * Get tasks completed within a date range (for weekly review).
 * Uses server-side $filter to avoid fetching entire completion history.
 */
export async function getCompletedTasksInRange(
  startISO: string,
  endISO: string
): Promise<ServiceResult<TodoTask[]>> {
  try {
    const listsResult = await getLists();
    if (!listsResult.success) {
      return { success: false, data: [], error: listsResult.error };
    }

    const client = getGraphClient();
    // Strip timezone offset — Graph's completedDateTime/dateTime is a bare local datetime
    const stripOffset = (iso: string) => iso.replace(/[+-]\d{2}:\d{2}$/, '').replace(/Z$/, '');
    const startBare = stripOffset(startISO);
    const endBare = stripOffset(endISO);
    // OData filter: completed tasks with completedDateTime in range
    const filter = `status eq 'completed' and completedDateTime/dateTime ge '${startBare}' and completedDateTime/dateTime le '${endBare}'`;

    const results = await Promise.all(
      listsResult.data.map(async (list) => {
        try {
          const response = await withRetry(() =>
            client.api(`/me/todo/lists/${list.id}/tasks`)
              .query({ $filter: filter, $top: '100' })
              .get()
          );
          return (response.value || []).map((t: any) => parseTask(t, list.id, list.displayName));
        } catch (err) {
          logger.warn({ err, listId: list.id }, 'getCompletedTasksInRange: failed to query list');
          return [] as TodoTask[];
        }
      })
    );

    return { success: true, data: results.flat() };
  } catch (err) {
    logger.error({ err }, 'Failed to get completed tasks');
    return { success: false, data: [], error: (err as Error).message };
  }
}

// ─── Checklist Items ─────────────────────────────────────────────────

/**
 * Get checklist items (steps) for a task.
 */
export async function getChecklistItems(
  listId: string,
  taskId: string
): Promise<ServiceResult<ChecklistItem[]>> {
  try {
    const client = getGraphClient();
    const response = await withRetry(() =>
      client.api(`/me/todo/lists/${listId}/tasks/${taskId}/checklistItems`).get()
    );

    const items: ChecklistItem[] = (response.value || []).map((item: any) => ({
      id: item.id || '',
      displayName: item.displayName || '',
      isChecked: item.isChecked ?? false,
    }));

    return { success: true, data: items };
  } catch (err) {
    logger.error({ err, listId, taskId }, 'Failed to fetch checklist items');
    return { success: false, data: [], error: (err as Error).message };
  }
}

/**
 * Add a checklist item (step) to a task.
 */
export async function addChecklistItem(
  listId: string,
  taskId: string,
  displayName: string
): Promise<ServiceResult<ChecklistItem>> {
  try {
    const client = getGraphClient();
    const response = await withRetry(() =>
      client.api(`/me/todo/lists/${listId}/tasks/${taskId}/checklistItems`).post({
        displayName,
      })
    );

    return {
      success: true,
      data: {
        id: response.id || '',
        displayName: response.displayName || '',
        isChecked: response.isChecked ?? false,
      },
    };
  } catch (err) {
    logger.error({ err, listId, taskId }, 'Failed to add checklist item');
    return { success: false, data: null as any, error: (err as Error).message };
  }
}

export async function updateChecklistItem(
  listId: string,
  taskId: string,
  checklistItemId: string,
  isChecked: boolean,
): Promise<ServiceResult<ChecklistItem>> {
  try {
    const client = getGraphClient();
    const response = await withRetry(() =>
      client.api(`/me/todo/lists/${listId}/tasks/${taskId}/checklistItems/${checklistItemId}`).patch({
        isChecked,
      })
    );

    return {
      success: true,
      data: {
        id: response.id || checklistItemId,
        displayName: response.displayName || '',
        isChecked: response.isChecked ?? isChecked,
      },
    };
  } catch (err) {
    logger.error({ err, listId, taskId, checklistItemId }, 'Failed to update checklist item');
    return { success: false, data: null as any, error: (err as Error).message };
  }
}

export async function deleteChecklistItem(
  listId: string,
  taskId: string,
  checklistItemId: string,
): Promise<ServiceResult<void>> {
  try {
    const client = getGraphClient();
    await withRetry(() =>
      client.api(`/me/todo/lists/${listId}/tasks/${taskId}/checklistItems/${checklistItemId}`).delete()
    );
    return { success: true, data: undefined };
  } catch (err) {
    logger.error({ err, listId, taskId, checklistItemId }, 'Failed to delete checklist item');
    return { success: false, data: undefined, error: (err as Error).message };
  }
}

// ─── Move Task ───────────────────────────────────────────────────────

/**
 * Move a task from one list to another.
 * Graph API has no move endpoint — we copy to new list then delete from old.
 */
export async function moveTask(
  fromListId: string,
  taskId: string,
  toListId: string,
  toListName: string
): Promise<ServiceResult<TodoTask>> {
  try {
    const client = getGraphClient();

    // 1. Get the full task
    const task = await withRetry(() =>
      client.api(`/me/todo/lists/${fromListId}/tasks/${taskId}`).get()
    );

    // 2. Create in new list (preserve key fields)
    const newTaskBody: any = {
      title: task.title,
      importance: task.importance,
      status: task.status,
    };
    if (task.body?.content) {
      newTaskBody.body = { content: task.body.content, contentType: task.body.contentType || 'text' };
    }
    if (task.dueDateTime) {
      newTaskBody.dueDateTime = task.dueDateTime;
    }
    if (task.reminderDateTime) {
      newTaskBody.reminderDateTime = task.reminderDateTime;
      newTaskBody.isReminderOn = true;
    }

    const created = await withRetry(() =>
      client.api(`/me/todo/lists/${toListId}/tasks`).post(newTaskBody)
    );

    // 3. Delete from old list. If this half fails, roll back the copy so the
    // provider does not retain duplicate active tasks.
    try {
      await withRetry(() =>
        client.api(`/me/todo/lists/${fromListId}/tasks/${taskId}`).delete()
      );
    } catch (deleteErr) {
      if (created?.id) {
        try {
          await withRetry(() =>
            client.api(`/me/todo/lists/${toListId}/tasks/${created.id}`).delete()
          );
        } catch (rollbackErr) {
          logger.error(
            { err: rollbackErr, fromListId, taskId, newTaskId: created.id, toListId },
            'moveTask: rollback failed after source delete failure',
          );
        }
      }
      logger.error({ err: deleteErr, fromListId, taskId, newTaskId: created.id, toListId }, 'moveTask failed while deleting source task');
      return { success: false, data: null as any, error: (deleteErr as Error).message };
    }

    return { success: true, data: parseTask(created, toListId, toListName) };
  } catch (err) {
    logger.error({ err, fromListId, taskId, toListId }, 'Failed to move task');
    return { success: false, data: null as any, error: (err as Error).message };
  }
}

// ─── Shared List Tasks ───────────────────────────────────────────────

/**
 * Get all pending tasks from shared lists (for assignment notifications).
 */
export async function getSharedListPendingTasks(): Promise<ServiceResult<TodoTask[]>> {
  try {
    const listsResult = await getLists();
    if (!listsResult.success) {
      return { success: false, data: [], error: listsResult.error };
    }

    const sharedLists = listsResult.data.filter((l) => l.isShared);
    if (sharedLists.length === 0) {
      return { success: true, data: [] };
    }

    const results = await Promise.all(
      sharedLists.map((list) => getTasks(list.id, list.displayName, { status: 'active' }))
    );

    const allTasks: TodoTask[] = [];
    for (const tasksResult of results) {
      if (tasksResult.success) {
        allTasks.push(...tasksResult.data);
      }
    }

    return { success: true, data: allTasks };
  } catch (err) {
    logger.error({ err }, 'Failed to get shared list pending tasks');
    return { success: false, data: [], error: (err as Error).message };
  }
}
