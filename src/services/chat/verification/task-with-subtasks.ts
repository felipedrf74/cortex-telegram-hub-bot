// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type TaskChecklistProviderLike = {
  getTask?: (listId: string, taskId: string, listName?: string) => Promise<any>;
  getChecklistItems?: (listId: string, taskId: string) => Promise<any>;
};

export type TaskWithSubtasksVerification = {
  ok: boolean;
  task: any | null;
  checklistItems: Array<{ id: string; displayName: string; isChecked: boolean }>;
  missingSubtasks: string[];
  warnings: string[];
  verificationBlind: boolean;
};

export async function verifyTaskWithSubtasks(
  provider: TaskChecklistProviderLike,
  listId: string,
  taskId: string,
  expectedTitle: string,
  expectedSubtasks: string[],
): Promise<TaskWithSubtasksVerification> {
  const warnings: string[] = [];
  let task: any | null = null;
  if (typeof provider.getTask === 'function') {
    const taskResult = await provider.getTask(listId, taskId);
    if (taskResult?.success && taskResult.data) task = taskResult.data;
  }
  if (!task) warnings.push('task_read_back_unavailable');

  let checklistItems = Array.isArray(task?.checklistItems) ? task.checklistItems : [];
  let checklistReadSucceeded = Array.isArray(task?.checklistItems);
  if (checklistItems.length === 0 && typeof provider.getChecklistItems === 'function') {
    try {
      const checklistResult = await provider.getChecklistItems(listId, taskId);
      if (checklistResult?.success && Array.isArray(checklistResult.data)) {
        checklistItems = checklistResult.data;
        checklistReadSucceeded = true;
      }
    } catch {
      // Unknown checklist state must stay unknown; callers should not re-add blindly.
    }
  }

  const verificationBlind = expectedSubtasks.length > 0 && !task && !checklistReadSucceeded;
  if (verificationBlind) warnings.push('checklist_read_back_unavailable');

  if (task && normalizeTaskComparable(task.title || task.subject) !== normalizeTaskComparable(expectedTitle)) {
    warnings.push('created_task_title_mismatch');
  }
  const actualSubtasks = checklistItems.map((item: any) => normalizeTaskComparable(item.displayName || item.title));
  const missing = verificationBlind
    ? []
    : expectedSubtasks.filter((subtask) => !actualSubtasks.includes(normalizeTaskComparable(subtask)));
  if (missing.length > 0) warnings.push('created_subtasks_missing');

  return {
    ok: warnings.length === 0,
    task,
    checklistItems: checklistItems.map((item: any) => ({
      id: String(item.id),
      displayName: String(item.displayName || item.title || ''),
      isChecked: !!item.isChecked,
    })),
    missingSubtasks: missing,
    warnings,
    verificationBlind,
  };
}

export function normalizeTaskComparable(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}
