// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ServiceResult, TodoTask } from '../microsoft-todo';
import { NativeTaskAdapter } from './native-adapter';
import { getAllTasks } from './unified-task-store';
import { normalizeStoredTaskPriority, priorityToImportance } from './task-priority';
import type { NormalizedTask } from './types';

const nativeAdapter = new NativeTaskAdapter();

export async function getProviderAwarePendingTodoTasks(userId: number): Promise<ServiceResult<TodoTask[]>> {
  try {
    const tasks = await getProviderAwareTaskReadModel(userId);
    return {
      success: true,
      data: tasks
        .filter((task) => task.status !== 'completed' && task.status !== 'cancelled')
        .map(toTodoTask),
    };
  } catch (err) {
    return {
      success: false,
      data: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getProviderAwareTodoTasksDueInRange(
  userId: number,
  startDate: string,
  endDate: string,
): Promise<ServiceResult<TodoTask[]>> {
  try {
    const start = dateOnly(startDate);
    const end = dateOnly(endDate);
    if (!start || !end) {
      return { success: false, data: [], error: 'Invalid date range' };
    }
    const tasks = await getProviderAwareTaskReadModel(userId);
    return {
      success: true,
      data: tasks
        .filter((task) => task.status !== 'completed' && task.status !== 'cancelled')
        .filter((task) => {
          const due = dateOnly(task.dueDate);
          return due != null && due >= start && due <= end;
        })
        .map(toTodoTask),
    };
  } catch (err) {
    return {
      success: false,
      data: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getProviderAwareTaskReadModel(userId: number): Promise<NormalizedTask[]> {
  const byKey = new Map<string, NormalizedTask>();

  for (const task of getAllTasks(userId, { includeDeleted: false })) {
    byKey.set(taskKey(task), task);
  }

  const native = await nativeAdapter.getTasks(userId);
  for (const task of native.tasks) {
    // Native rows are the canonical source for chat-created Nexus tasks; if a
    // unified projection exists with the same provider/external ID, prefer the
    // native row so read-after-write sees the latest local mutation.
    byKey.set(taskKey(task), task);
  }

  return [...byKey.values()].sort(compareTasksForRead);
}

function taskKey(task: NormalizedTask): string {
  const provider = task.provider || 'nexus';
  const externalId = task.externalId || String(task.id ?? '');
  return `${provider}:${externalId}`;
}

function compareTasksForRead(left: NormalizedTask, right: NormalizedTask): number {
  const leftDue = left.dueDate ?? '9999-12-31';
  const rightDue = right.dueDate ?? '9999-12-31';
  if (leftDue !== rightDue) return leftDue.localeCompare(rightDue);
  // M10 P-scale (NEX-17): P1 (1) first, then 2,3,4; none (0) last.
  const priorityDelta = taskPriorityRank(left.priority) - taskPriorityRank(right.priority);
  if (priorityDelta !== 0) return priorityDelta;
  return left.title.localeCompare(right.title);
}

function taskPriorityRank(value: number): number {
  const priority = normalizeStoredTaskPriority(value);
  return priority === 0 ? 5 : priority;
}

function toTodoTask(task: NormalizedTask): TodoTask {
  return {
    id: task.externalId || String(task.id ?? ''),
    listId: String(task.projectId ?? ''),
    listName: task.projectName || providerLabel(task.provider),
    title: task.title,
    body: task.description || task.notes,
    // M10 (NEX-17): shared P-scale table (P1/P2→high, P3→normal, P4→low).
    importance: priorityToImportance(task.priority),
    status: task.status === 'completed'
      ? 'completed'
      : task.status === 'in_progress'
        ? 'inProgress'
        : 'notStarted',
    dueDateTime: task.dueDate,
    isReminderOn: false,
    createdDateTime: stringFromProviderData(task.providerData, 'created_at')
      ?? stringFromProviderData(task.providerData, 'createdDateTime')
      ?? new Date(0).toISOString(),
    completedDateTime: task.completedAt,
    checklistItems: task.checklistItems?.map((item) => ({
      id: item.id,
      displayName: item.displayName,
      isChecked: item.isChecked,
    })),
    recurrence: task.recurrence as any,
  };
}

function providerLabel(provider: NormalizedTask['provider']): string {
  if (provider === 'nexus') return 'Inbox';
  if (provider === 'ms_todo') return 'Microsoft To Do';
  return provider;
}

function dateOnly(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return raw.slice(0, 10);
}

function stringFromProviderData(providerData: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = providerData?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
