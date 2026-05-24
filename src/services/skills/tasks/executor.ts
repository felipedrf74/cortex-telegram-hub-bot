// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { claimChatActionRunForExecution, updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import { rememberRecentChatEntity } from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep, ChatStepExecutionResult } from '../../chat/types';
import { getTaskProviderForUser } from '../../task-store/task-router';
import { resolveTaskCreationList } from '../../task-store/task-list-resolution';
import { claimActionRunForStepExecution, parseStoredRunResult, reconciliationPendingResult, replayDuplicateClaimedActionRun, updateClaimedActionRun, withProviderWriteTimeout } from '../../chat/executor/helpers';
import { normalizeTaskComparable, verifyTaskWithSubtasks } from '../../chat/verification/task-with-subtasks';

export async function executeTaskCreateStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  taskProviderForUser: typeof getTaskProviderForUser,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const provider = taskProviderForUser(input.userId);
  if (typeof provider.createTask !== 'function') return { step, status: 'blocked', error: 'task_provider_not_writable' };
  const args = step.args as any;
  const claim = persistRuns
    ? claimChatActionRunForExecution({
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      normalizedActionHash: step.idempotencyKey,
      provider: 'nexus',
      actionType: step.action,
      risk: step.risk,
      request: step.args,
      nowIso: plan.createdAt,
    })
    : null;
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    const list = await resolveTaskCreationList(provider, typeof args.list === 'string' ? args.list : null);
    if (!list?.id) throw new Error('missing_task_list');
    const created = await withProviderWriteTimeout(() => provider.createTask(String(list.id), list.displayName || list.name || 'Tasks', {
      title: String(args.title),
      body: typeof args.notes === 'string' ? args.notes : undefined,
      dueDateTime: typeof args.dueDateTime === 'string' ? args.dueDateTime : undefined,
    }));
    if (!created?.success || !created.data?.id) throw new Error('task_create_failed');
    const readBack = typeof provider.getTask === 'function'
      ? await provider.getTask(String(list.id), String(created.data.id), list.displayName || list.name || 'Tasks')
      : null;
    const verified = !readBack || (readBack.success !== false && String(readBack.data?.title || readBack.data?.subject || created.data.title || '').trim() === String(args.title).trim());
    const result = { task: created.data, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: String(created.data.id),
      verification: { verified, expected: step.verification.expectedFields },
    })) return reconciliationPendingResult(step, status);
    if (verified) {
      const now = new Date().toISOString();
      rememberRecentChatEntity({
        userId: input.userId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        node: {
          entityId: String(created.data.id),
          entityType: 'task',
          provider: 'nexus',
          surface: 'chat',
          userVisibleLabel: String(args.title),
          createdOrViewedAt: now,
          lastVerifiedAt: now,
          allowedFollowupActions: ['complete_task', 'update_task', 'delete_task'],
          confidence: 0.96,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          sourceTurnId: input.messageId,
          metadata: {
            listId: String(list.id),
            listName: list.displayName || list.name || 'Tasks',
          },
        },
      });
    }
    return { step, status, result };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'task_create_failed' };
  }
}

export async function executeTaskWithSubtasksStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  taskProviderForUser: typeof getTaskProviderForUser,
  persistRuns: boolean,
): Promise<ChatStepExecutionResult> {
  const provider = taskProviderForUser(input.userId);
  if (typeof provider.createTask !== 'function' || typeof provider.addChecklistItem !== 'function') {
    return { step, status: 'blocked', error: 'task_provider_missing_checklist_support' };
  }
  const args = normalizeTaskWithSubtasksArgs(step.args);
  if (!args.title || args.subtasks.length === 0) return { step, status: 'blocked', error: 'task_with_subtasks_missing_fields' };

  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const recovered = await recoverTaskWithSubtasksRun(claim, step, provider, args);
  if (recovered) return recovered;

  try {
    const list = await resolveTaskCreationList(provider, args.list);
    if (!list?.id) throw new Error('missing_task_list');
    const created = await withProviderWriteTimeout(() => provider.createTask(String(list.id), list.displayName || list.name || 'Tasks', {
      title: args.title,
      body: args.notes || undefined,
      importance: args.priority || undefined,
      dueDateTime: args.dueAt || undefined,
    }));
    if (!created?.success || !created.data?.id) throw new Error('task_create_failed');

    const taskId = String(created.data.id);
    const listId = String(created.data.listId || list.id);
    if (claim) {
      updateChatActionRun(claim.row.id, 'verifying', {
        result: {
          task: created.data,
          listId,
          checklistItems: [],
          failedSubtasks: [],
          warnings: [],
          verificationStatus: 'pending',
        },
        providerObjectId: taskId,
      });
    }

    const createdItems: Array<{ id: string; displayName: string; isChecked: boolean }> = [];
    const failedSubtasks: string[] = [];
    for (const subtask of args.subtasks) {
      try {
        const added = await withProviderWriteTimeout(() => provider.addChecklistItem!(listId, taskId, subtask));
        if (added?.success && added.data) {
          createdItems.push({
            id: String(added.data.id || createdItems.length + 1),
            displayName: String(added.data.displayName || subtask),
            isChecked: !!added.data.isChecked,
          });
        } else {
          failedSubtasks.push(subtask);
        }
      } catch {
        failedSubtasks.push(subtask);
      }
    }

    const verification = await verifyTaskWithSubtasks(
      provider,
      listId,
      taskId,
      args.title,
      args.subtasks.filter((subtask) => !failedSubtasks.includes(subtask)),
    );
    const checklistItems = verification.checklistItems.length > 0 ? verification.checklistItems : createdItems;
    const verified = failedSubtasks.length === 0 && verification.ok;
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    const result = buildTaskSubtasksResult({
      task: verification.task || created.data,
      listId,
      checklistItems,
      failedSubtasks,
      warnings: verification.warnings,
      verificationStatus: verified ? 'verified' : 'partial_failure',
      responseType: 'task_created',
    });
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: taskId,
      verification: { verified, expected: step.verification.expectedFields, warnings: verification.warnings },
    })) return reconciliationPendingResult(step, status);
    rememberTaskForFollowup(input, taskId, listId, args.title, list.displayName || list.name || 'Tasks', plan.createdAt);
    return { step, status, result, error: verified ? undefined : 'task_subtasks_partial_verification' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'task_with_subtasks_failed' };
  }
}

export async function executeAddSubtasksToTaskStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  taskProviderForUser: typeof getTaskProviderForUser,
  persistRuns: boolean,
): Promise<ChatStepExecutionResult> {
  const provider = taskProviderForUser(input.userId);
  if (typeof provider.searchTasks !== 'function' || typeof provider.addChecklistItem !== 'function') {
    return { step, status: 'blocked', error: 'task_provider_missing_search_or_checklist' };
  }
  const args = normalizeTaskWithSubtasksArgs(step.args);
  if (!args.title || args.subtasks.length === 0) return { step, status: 'blocked', error: 'task_with_subtasks_missing_fields' };

  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;

  try {
    const matchesResult = await provider.searchTasks(args.title);
    const matches = extractArray(matchesResult?.data || matchesResult)
      .filter((task: any) => normalizeTaskComparable(task?.title || task?.subject) === normalizeTaskComparable(args.title));
    if (matches.length !== 1) {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', { error: { reason: matches.length > 1 ? 'multiple_task_matches' : 'no_task_match' } });
      return { step, status: 'blocked', error: matches.length > 1 ? 'multiple_task_matches' : 'no_task_match' };
    }

    const task = matches[0] as any;
    const taskId = String(task.id || task.taskId || '');
    const listId = String(task.listId || task.projectId || args.list || '');
    if (!taskId || !listId) throw new Error('task_target_missing_identity');

    const addedItems: Array<{ id: string; displayName: string; isChecked: boolean }> = [];
    const failedSubtasks: string[] = [];
    for (const subtask of args.subtasks) {
      try {
        const added = await withProviderWriteTimeout(() => provider.addChecklistItem!(listId, taskId, subtask));
        if (added?.success && added.data) {
          addedItems.push({
            id: String(added.data.id || addedItems.length + 1),
            displayName: String(added.data.displayName || subtask),
            isChecked: !!added.data.isChecked,
          });
        } else {
          failedSubtasks.push(subtask);
        }
      } catch {
        failedSubtasks.push(subtask);
      }
    }

    const verification = await verifyTaskWithSubtasks(
      provider,
      listId,
      taskId,
      args.title,
      args.subtasks.filter((subtask) => !failedSubtasks.includes(subtask)),
    );
    const checklistItems = verification.checklistItems.length > 0 ? verification.checklistItems : addedItems;
    const verified = failedSubtasks.length === 0 && verification.ok;
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    const result = buildTaskSubtasksResult({
      task: verification.task || task,
      listId,
      checklistItems,
      failedSubtasks,
      warnings: verification.warnings,
      verificationStatus: verified ? 'verified' : 'partial_failure',
      responseType: 'task_subtasks_added',
    });
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: taskId,
      verification: { verified, expected: step.verification.expectedFields, warnings: verification.warnings },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'task_subtasks_partial_verification' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'task_subtasks_add_failed' };
  }
}

export async function executeTaskMutationStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  taskProviderForUser: typeof getTaskProviderForUser,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const provider = taskProviderForUser(input.userId);
  const args = step.args as any;
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    if (step.action === 'create_checklist') {
      if (typeof provider.createTask !== 'function') throw new Error('task_provider_not_writable');
      const list = await resolveTaskCreationList(provider, typeof args.list === 'string' ? args.list : null);
      if (!list?.id) throw new Error('missing_task_list');
      const created = await withProviderWriteTimeout(() => provider.createTask(String(list.id), list.displayName || list.name || 'Tasks', {
        title: String(args.title),
        body: typeof args.notes === 'string' ? args.notes : undefined,
      }));
      if (!created?.success || !created.data?.id) throw new Error('task_create_failed');
      const items = Array.isArray(args.items) ? args.items.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0) : [];
      const added: unknown[] = [];
      for (const item of items) {
        if (typeof provider.addChecklistItem !== 'function') break;
        const addedItem = await withProviderWriteTimeout(() => provider.addChecklistItem(String(list.id), String(created.data.id), item));
        added.push(addedItem?.data ?? addedItem);
      }
      const verified = items.length === 0 || added.length === items.length;
      const result = { task: created.data, checklistItems: added, verified };
      const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
      if (!updateClaimedActionRun(claim, status, { result, providerObjectId: String(created.data.id), verification: { verified } })) {
        return reconciliationPendingResult(step, status);
      }
      return { step, status, result, error: verified ? undefined : 'checklist_provider_partial' };
    }

    const target = await resolveTaskMutationTarget(provider, args);
    if (!target) return { step, status: 'blocked', error: 'task_target_not_found_or_ambiguous' };
    if (step.action === 'complete_task') {
      if (typeof provider.completeTask !== 'function') throw new Error('task_provider_cannot_complete');
      await withProviderWriteTimeout(() => provider.completeTask(target.listId, target.taskId));
    } else if (step.action === 'delete_task') {
      if (typeof provider.deleteTask !== 'function') throw new Error('task_provider_cannot_delete');
      await withProviderWriteTimeout(() => provider.deleteTask(target.listId, target.taskId));
    } else {
      if (typeof provider.updateTask !== 'function') throw new Error('task_provider_cannot_update');
      const changed = typeof args.changedFields === 'object' && args.changedFields ? args.changedFields as Record<string, unknown> : {};
      const updates = {
        ...changed,
        title: typeof args.title === 'string' ? args.title : changed.title,
        body: typeof args.notes === 'string' ? args.notes : changed.body,
        dueDateTime: typeof args.reminderAt === 'string'
          ? args.reminderAt
          : typeof args.dueDateTime === 'string'
            ? args.dueDateTime
            : changed.dueDateTime,
      };
      await withProviderWriteTimeout(() => provider.updateTask(target.listId, target.taskId, updates, target.listName));
    }

    const readBack = typeof provider.getTask === 'function'
      ? await provider.getTask(target.listId, target.taskId, target.listName)
      : null;
    const verified = step.action === 'delete_task'
      ? !readBack || readBack.success === false || !readBack.data
      : !readBack || readBack.success !== false;
    const result = { taskId: target.taskId, listId: target.listId, verified, task: readBack?.data ?? null };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: target.taskId,
      verification: { verified, expected: step.verification.expectedFields },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'task_mutation_failed' };
  }
}

export async function resolveTaskMutationTarget(
  provider: any,
  args: Record<string, unknown>,
): Promise<{ taskId: string; listId: string; listName?: string } | null> {
  const explicitTaskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
  const explicitListId = typeof args.listId === 'string' ? args.listId.trim() : typeof args.list === 'string' ? args.list.trim() : '';
  if (explicitTaskId && explicitListId) {
    return { taskId: explicitTaskId, listId: explicitListId, listName: typeof args.listName === 'string' ? args.listName : undefined };
  }
  const title = typeof args.title === 'string' ? args.title.trim().toLowerCase() : '';
  const searchQuery = title || explicitTaskId;
  const candidates = typeof provider.searchTasks === 'function'
    ? await provider.searchTasks(searchQuery)
    : typeof provider.getAllPendingTasks === 'function'
      ? await provider.getAllPendingTasks()
      : null;
  const data = Array.isArray(candidates?.data) ? candidates.data : [];
  const matches = data.filter((candidate: any) => {
    const id = String(candidate.id || candidate.taskId || '').trim();
    const candidateTitle = String(candidate.title || candidate.subject || '').trim().toLowerCase();
    if (explicitTaskId && id === explicitTaskId) return true;
    if (title && candidateTitle === title) return true;
    return false;
  });
  if (matches.length !== 1) return null;
  const match = matches[0] as any;
  const taskId = String(match.id || match.taskId || '');
  const listId = String(match.listId || match.projectId || explicitListId || '');
  if (!taskId || !listId) return null;
  return { taskId, listId, listName: typeof match.listName === 'string' ? match.listName : typeof match.projectName === 'string' ? match.projectName : undefined };
}

type TaskWithSubtasksArgs = {
  title: string;
  subtasks: string[];
  dueAt: string | null;
  reminderAt: string | null;
  notes: string | null;
  priority: string | null;
  list: string | null;
};

function normalizeTaskWithSubtasksArgs(raw: Record<string, unknown>): TaskWithSubtasksArgs {
  return {
    title: normalizeTaskTitle(raw.title),
    subtasks: normalizeTaskSubtasks(raw.subtasks),
    dueAt: typeof raw.dueAt === 'string' && raw.dueAt.trim() ? raw.dueAt.trim() : null,
    reminderAt: typeof raw.reminderAt === 'string' && raw.reminderAt.trim() ? raw.reminderAt.trim() : null,
    notes: typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim() : null,
    priority: typeof raw.priority === 'string' && raw.priority.trim() ? raw.priority.trim() : null,
    list: typeof raw.list === 'string' && raw.list.trim() ? raw.list.trim() : null,
  };
}

function normalizeTaskTitle(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[:\-–—\s]+|[:\-–—\s.!?]+$/g, '')
    .slice(0, 500)
    .trim();
}

function normalizeTaskSubtasks(value: unknown): string[] {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of input) {
    const normalized = normalizeTaskTitle(item).slice(0, 200).trim();
    if (!normalized) continue;
    const key = normalizeTaskComparable(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= 25) break;
  }
  return output;
}

function buildTaskSubtasksResult(input: {
  task: any;
  listId: string;
  checklistItems: Array<{ id: string; displayName: string; isChecked: boolean }>;
  failedSubtasks: string[];
  warnings: string[];
  verificationStatus: 'verified' | 'partial_failure';
  responseType: 'task_created' | 'task_subtasks_added';
}): Record<string, unknown> {
  const taskId = String(input.task?.id || input.task?.entityId || input.task?.taskId || '');
  const title = String(input.task?.title || input.task?.subject || 'Task');
  return {
    type: input.responseType,
    task: input.task,
    taskId,
    listId: String(input.task?.listId || input.listId || ''),
    title,
    checklistItems: input.checklistItems,
    subtasks: input.checklistItems.map((item) => ({
      id: item.id,
      title: item.displayName,
      isChecked: item.isChecked,
    })),
    failedSubtasks: input.failedSubtasks,
    warnings: input.warnings,
    verificationStatus: input.verificationStatus,
    verified: input.verificationStatus === 'verified',
  };
}

async function recoverTaskWithSubtasksRun(
  claim: ReturnType<typeof claimActionRunForStepExecution> | null,
  step: ChatPlanStep,
  provider: any,
  args: TaskWithSubtasksArgs,
): Promise<ChatStepExecutionResult | null> {
  if (!claim || claim.acquired) return null;
  const replay = replayDuplicateClaimedActionRun(claim, step);
  if (!replay || (replay.status !== 'verified_pending' && replay.status !== 'partial_success')) return replay;

  const stored = parseStoredRunResult(claim.row);
  const taskId = String(claim.row.provider_object_id || stored.providerObjectId || (stored.task as any)?.id || '');
  const listId = String((stored as any).listId || (stored.task as any)?.listId || '');
  if (!taskId || !listId || claim.row.status === 'executing') return replay;

  const verified = await verifyTaskWithSubtasks(provider, listId, taskId, args.title, args.subtasks);
  if (verified.verificationBlind) {
    return {
      step,
      status: 'verified_pending',
      result: { ...stored, warnings: verified.warnings, currentStatus: claim.row.status },
      error: 'verification_blind',
    };
  }

  const missing = verified.missingSubtasks;
  const addedItems: Array<{ id: string; displayName: string; isChecked: boolean }> = [];
  const failedSubtasks: string[] = [];
  if (missing.length > 0 && typeof provider.addChecklistItem === 'function') {
    for (const subtask of missing) {
      try {
        const added = await withProviderWriteTimeout(() => provider.addChecklistItem(listId, taskId, subtask));
        if (added?.success && added.data) {
          addedItems.push({
            id: String(added.data.id || `${addedItems.length + 1}`),
            displayName: String(added.data.displayName || subtask),
            isChecked: !!added.data.isChecked,
          });
        } else {
          failedSubtasks.push(subtask);
        }
      } catch {
        failedSubtasks.push(subtask);
      }
    }
  }

  const after = missing.length > 0
    ? await verifyTaskWithSubtasks(provider, listId, taskId, args.title, args.subtasks)
    : verified;
  const checklistItems = after.checklistItems.length > 0 ? after.checklistItems : addedItems;
  const ok = failedSubtasks.length === 0 && after.ok;
  const status: ChatActionRunStatus = ok ? 'verified_success' : 'partial_success';
  const result = buildTaskSubtasksResult({
    task: after.task || (stored as any).task || { id: taskId, listId, title: args.title },
    listId,
    checklistItems,
    failedSubtasks,
    warnings: [
      claim.row.status === 'verifying'
        ? 'Recovered an in-progress request and reused the existing task instead of creating another one.'
        : 'Duplicate request detected; returned the existing task instead of creating another one.',
      ...after.warnings,
    ],
    verificationStatus: ok ? 'verified' : 'partial_failure',
    responseType: 'task_created',
  });
  if (!updateClaimedActionRun(claim, status, {
    result,
    providerObjectId: taskId,
    verification: { verified: ok, expected: step.verification.expectedFields, warnings: after.warnings },
  })) return reconciliationPendingResult(step, status);
  return { step, status, result, error: ok ? undefined : 'task_subtasks_partial_verification' };
}

function rememberTaskForFollowup(
  input: ChatPlannerInput,
  taskId: string,
  listId: string,
  title: string,
  listName: string,
  nowIso: string,
): void {
  const now = nowIso || new Date().toISOString();
  rememberRecentChatEntity({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    node: {
      entityId: taskId,
      entityType: 'task',
      provider: 'nexus',
      surface: 'chat',
      userVisibleLabel: title,
      createdOrViewedAt: now,
      lastVerifiedAt: now,
      allowedFollowupActions: ['complete_task', 'update_task', 'delete_task', 'add_subtasks_to_task'],
      confidence: 0.96,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      sourceTurnId: input.messageId,
      metadata: { listId, listName },
    },
  });
}

function extractArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as any).tasks)) return (value as any).tasks;
  return [];
}
