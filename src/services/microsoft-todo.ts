// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getGraphClient, isMicrosoftConfigured } from './microsoft-auth';
import { config } from '../config';
import { logger } from '../utils/logger';

// ─── Types ──────────────────────────────────────────────────────────

export interface TodoList {
  id: string;
  displayName: string;
  isOwner: boolean;
  isShared: boolean;
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

let cachedLists: TodoList[] | null = null;
let cachedListsAt = 0;
const LIST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export function invalidateListCache(): void {
  cachedLists = null;
  cachedListsAt = 0;
}

// ─── Task Lists ─────────────────────────────────────────────────────

export async function getLists(): Promise<ServiceResult<TodoList[]>> {
  try {
    // Return cached lists if fresh
    if (cachedLists && Date.now() - cachedListsAt < LIST_CACHE_TTL) {
      return { success: true, data: cachedLists };
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
    }));

    cachedLists = lists;
    cachedListsAt = Date.now();

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
 * Get the default list (matching config.todo.defaultList name).
 */
export async function getDefaultList(): Promise<TodoList | null> {
  return findListByName(config.todo.defaultList);
}

// ─── Tasks ──────────────────────────────────────────────────────────

export async function getTasks(
  listId: string,
  listName: string,
  filter?: { status?: string; top?: number }
): Promise<ServiceResult<TodoTask[]>> {
  try {
    const client = getGraphClient();
    let request = client.api(`/me/todo/lists/${listId}/tasks`);

    // NOTE: Do NOT add $select here — Microsoft Graph's OData parser chokes on
    // "title" in $select (RequestBroker--ParseUri / 400 Invalid request).
    // Omitting $select returns all standard fields anyway; the overhead is negligible.
    const query: Record<string, string> = {
      $orderby: 'createdDateTime DESC',
      $top: String(filter?.top || 50),
    };

    if (filter?.status) {
      query.$filter = `status eq '${filter.status}'`;
    }

    request = request.query(query);

    const allTasks: TodoTask[] = [];
    let response = await withRetry(() => request.get());
    allTasks.push(...(response.value || []).map((t: any) => parseTask(t, listId, listName)));

    // Handle pagination
    while (response['@odata.nextLink'] && allTasks.length < 200) {
      response = await withRetry(() =>
        client.api(response['@odata.nextLink']).get()
      );
      allTasks.push(...(response.value || []).map((t: any) => parseTask(t, listId, listName)));
    }

    return { success: true, data: allTasks };
  } catch (err) {
    logger.error({ err, listId }, 'Failed to fetch To Do tasks');
    return { success: false, data: [], error: (err as Error).message };
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
  }
): Promise<ServiceResult<TodoTask>> {
  try {
    const client = getGraphClient();
    const tz = config.app.timezone;

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

    const response = await withRetry(() =>
      client.api(`/me/todo/lists/${listId}/tasks`).post(taskBody)
    );

    // Track self-created tasks so shared list notifications can filter them out
    if (response.id) selfCreatedTaskIds.add(response.id);

    return { success: true, data: parseTask(response, listId, listName) };
  } catch (err) {
    logger.error({ err, listId }, 'Failed to create To Do task');
    return { success: false, data: null as any, error: (err as Error).message };
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
  },
  listName?: string
): Promise<ServiceResult<TodoTask>> {
  try {
    const client = getGraphClient();
    const tz = config.app.timezone;
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

    const response = await withRetry(() =>
      client.api(`/me/todo/lists/${listId}/tasks/${taskId}`).patch(patch)
    );

    // Use provided listName, or fall back to cache lookup
    const resolvedName = listName || (await getLists()).data.find((l) => l.id === listId)?.displayName || '';

    return { success: true, data: parseTask(response, listId, resolvedName) };
  } catch (err) {
    logger.error({ err, listId, taskId }, 'Failed to update To Do task');
    return { success: false, data: null as any, error: (err as Error).message };
  }
}

export async function completeTask(listId: string, taskId: string, listName?: string): Promise<ServiceResult<TodoTask>> {
  return updateTask(listId, taskId, { status: 'completed' }, listName);
}

export async function uncompleteTask(listId: string, taskId: string, listName?: string): Promise<ServiceResult<TodoTask>> {
  return updateTask(listId, taskId, { status: 'notStarted' }, listName);
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
    return { success: false, data: undefined, error: (err as Error).message };
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
              .query({ $filter: `contains(title,'${escaped}')`, $top: '50' })
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
  endISO: string
): Promise<ServiceResult<TodoTask[]>> {
  try {
    const listsResult = await getLists();
    if (!listsResult.success) {
      return { success: false, data: [], error: listsResult.error };
    }

    const start = new Date(startISO).getTime();
    const end = new Date(endISO).getTime();

    const results = await Promise.all(
      listsResult.data.map((list) => getTasks(list.id, list.displayName, { status: 'notStarted' }))
    );

    const dueTasks: TodoTask[] = [];
    for (const tasksResult of results) {
      if (tasksResult.success) {
        for (const task of tasksResult.data) {
          if (task.dueDateTime) {
            const due = new Date(task.dueDateTime).getTime();
            if (due >= start && due <= end) {
              dueTasks.push(task);
            }
          }
        }
      }
    }

    // Sort by due date
    dueTasks.sort((a, b) => {
      const aTime = a.dueDateTime ? new Date(a.dueDateTime).getTime() : Infinity;
      const bTime = b.dueDateTime ? new Date(b.dueDateTime).getTime() : Infinity;
      return aTime - bTime;
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
      listsResult.data.map((list) => getTasks(list.id, list.displayName, { status: 'notStarted' }))
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

    // 3. Delete from old list — if this fails, log the duplicate but still return success
    try {
      await withRetry(() =>
        client.api(`/me/todo/lists/${fromListId}/tasks/${taskId}`).delete()
      );
    } catch (deleteErr) {
      logger.error(
        { err: deleteErr, fromListId, taskId, newTaskId: created.id, toListId },
        'moveTask: created in new list but failed to delete from old — duplicate exists',
      );
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
      sharedLists.map((list) => getTasks(list.id, list.displayName, { status: 'notStarted' }))
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
