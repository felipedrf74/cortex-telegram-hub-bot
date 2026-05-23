// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { claimChatActionRunForExecution, updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import { rememberRecentChatEntity } from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import { getTaskProviderForUser } from '../../task-store/task-router';
import { resolveTaskCreationList } from '../../task-store/task-list-resolution';
import { claimActionRunForStepExecution, reconciliationPendingResult, replayDuplicateClaimedActionRun, updateClaimedActionRun, withProviderWriteTimeout } from '../../chat/executor/helpers';

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
