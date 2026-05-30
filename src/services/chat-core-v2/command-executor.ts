// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  evaluateChatCoreV2CommandBusGate,
  type ChatCoreV2CommandGateVerdict,
} from './command-bus';
import {
  getChatCoreV2Capability,
} from './capability-registry';
import {
  assessCommandWriteRisk,
} from './write-risk-policy';
import {
  buildChatCoreV2CommandResultResponse,
  normalizeChatCoreV2Locale,
  type ChatCoreV2Response,
  type ChatCoreV2Locale,
} from './response-contracts';
import {
  recordChatV2CommandEvent,
} from './command-events';
import {
  decisionDismissVersionForItem,
  isDecisionDismissEligibleStatus,
  isNotificationSnoozeEligibleStatus,
  notificationSnoozeVersionForItem,
} from './command-status-policy';
import { hashStable } from './deterministic-read/common';
import { getDb } from '../database';
import {
  completeTask,
  getTaskForUser,
} from '../task-store/task-service';
import { getTaskProviderForUser } from '../task-store/task-router';
import { resolveTaskCreationList } from '../task-store/task-list-resolution';
import { invalidateTaskCaches } from '../cache-coherence-registry';
import { computeContentHash } from '../task-store/unified-task-store';
import {
  getNotificationCenterItem,
  snoozeNotificationCenterItem,
} from '../notification-orchestrator';
import {
  dismissDecision,
  getDecisionItem,
} from '../decision-center';
import type {
  AICommandEnvelope,
  CapabilityDefinition,
  CommandStatus,
} from './types';

export const CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION = 'chat_core_v2_command_executor@1.0.0';

export type ChatCoreV2CommandExecutionRejection =
  | 'unsupported_command'
  | 'command_gate_rejected'
  | 'execution_failed'
  | 'verification_failed';

export interface ChatCoreV2CommandExecutionResult {
  ok: boolean;
  executorVersion: string;
  commandId: string;
  capabilityId?: string;
  gateVerdict: ChatCoreV2CommandGateVerdict;
  response?: ChatCoreV2Response;
  status: CommandStatus;
  reason?: ChatCoreV2CommandExecutionRejection;
  createdTaskId?: number;
  completedTaskId?: number;
  completedTaskIds?: number[];
  snoozedNotificationId?: string;
  dismissedDecisionId?: string;
}

export async function executeChatCoreV2Command(input: {
  command: AICommandEnvelope<Record<string, unknown>>;
  capabilityId: string;
  userId: number;
  tenantId: number;
  locale?: string | null;
  now?: Date;
}): Promise<ChatCoreV2CommandExecutionResult> {
  const now = input.now ?? new Date();
  const executeSnapshot = buildExecuteGateSnapshot(input.command, input.userId, input.tenantId);
  const gateVerdict = evaluateChatCoreV2CommandBusGate(input.command, {
    actorUserId: String(input.userId),
    tenantId: String(input.tenantId),
    delegatedScopes: input.command.authorization.delegatedScopes,
    permissionSnapshotVersion: input.command.authorization.permissionSnapshotVersion,
    currentEntityVersions: executeSnapshot.currentEntityVersions,
    decisionVersion: executeSnapshot.decisionVersion ?? input.command.preconditions.requiredDecisionVersion,
    invariantResults: executeSnapshot.invariantResults,
    now,
  }, 'execute');

  if (!gateVerdict.ok) {
    recordCommandEvent(input.command, input.capabilityId, 'command_rejected', gateVerdict.commandStatus, gateVerdict.reason ?? 'command_gate_rejected', now);
    return {
      ok: false,
      executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
      commandId: input.command.commandId,
      capabilityId: input.capabilityId,
      gateVerdict,
      status: gateVerdict.commandStatus,
      reason: 'command_gate_rejected',
    };
  }

  const capability = getChatCoreV2Capability(input.capabilityId);
  if (!capability || capability.commandType !== input.command.commandType || !isExecutableCommandType(input.command.commandType)) {
    recordCommandEvent(input.command, input.capabilityId, 'command_rejected', 'rejected_by_policy', 'unsupported_command', now);
    return {
      ok: false,
      executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
      commandId: input.command.commandId,
      capabilityId: input.capabilityId,
      gateVerdict,
      status: 'rejected_by_policy',
      reason: 'unsupported_command',
    };
  }

  recordCommandEvent(input.command, input.capabilityId, 'confirmation_received', 'confirmed', undefined, now);
  recordCommandEvent(input.command, input.capabilityId, 'execution_started', 'executing', undefined, now);

  if (input.command.commandType === 'tasks.complete') {
    return executeTaskComplete({
      ...input,
      capability,
      gateVerdict,
      now,
    });
  }
  if (input.command.commandType === 'notifications.snooze') {
    return executeNotificationSnooze({
      ...input,
      capability,
      gateVerdict,
      now,
    });
  }
  if (input.command.commandType === 'decision_center.dismiss') {
    return executeDecisionDismiss({
      ...input,
      capability,
      gateVerdict,
      now,
    });
  }

  return executeTaskCreate({
    ...input,
    capability,
    gateVerdict,
    now,
  });
}

function isExecutableCommandType(commandType: string): boolean {
  return commandType === 'tasks.create'
    || commandType === 'tasks.complete'
    || commandType === 'notifications.snooze'
    || commandType === 'decision_center.dismiss';
}

/**
 * The four sync command types the executor can actually run. Each one performs an
 * immediate read-back of the mutated entity inside its `execute*` path
 * (`getTaskForUser` / native_tasks SELECT / `snoozeNotificationCenterItem`
 * read-back / `dismissDecision` read-back) and only reports `verified` when the
 * read-back confirms the new state.
 */
export const CHAT_CORE_V2_SYNC_EXECUTABLE_COMMAND_TYPES = [
  'tasks.create',
  'tasks.complete',
  'notifications.snooze',
  'decision_center.dismiss',
] as const;

/**
 * Assert (WP-10) that `requiresReadbackVerification` from the write-risk policy is
 * satisfied by the only commands this executor can run — the four sync commands,
 * each of which performs an immediate read-back before claiming `verified`.
 *
 * This is honestly an assertion over the only executable command types (§5.I):
 * every write-risk class (A/B/C) sets `requiresReadbackVerification: true`, and
 * every executable command does an immediate read-back, so the contract holds by
 * construction. The REAL governance value is the action gateway's Class-C
 * blocking (`unsupported_write`, no execute envelope) plus the human-review
 * queue + notification — not this tautology. It exists so a future change that
 * either (a) adds an executable command that skips read-back, or (b) downgrades a
 * write-risk class to `requiresReadbackVerification: false`, trips a test.
 *
 * Returns true iff the contract holds for every executable command type. Pure.
 */
export function assertChatCoreV2ReadbackVerificationContract(): boolean {
  return CHAT_CORE_V2_SYNC_EXECUTABLE_COMMAND_TYPES.every((commandType) => {
    if (!isExecutableCommandType(commandType)) return false;
    // Every executable command's write-risk policy must require read-back.
    const capability = getChatCoreV2Capability(commandType);
    const capabilityRisk = capability?.risk ?? 'low';
    const assessment = assessCommandWriteRisk({
      commandType,
      domain: capability?.domain ?? 'tasks',
      capability: capabilityRisk,
    });
    return assessment.policy.requiresReadbackVerification === true;
  });
}

function buildExecuteGateSnapshot(
  command: AICommandEnvelope<Record<string, unknown>>,
  userId: number,
  tenantId: number,
): {
  currentEntityVersions: Record<string, string>;
  invariantResults: Record<string, boolean>;
  decisionVersion?: string;
} {
  if (command.commandType === 'tasks.complete') {
    return buildTaskCompleteExecuteGateSnapshot(command, userId);
  }
  if (command.commandType === 'notifications.snooze') {
    return buildNotificationExecuteGateSnapshot(command, userId, tenantId);
  }
  if (command.commandType === 'decision_center.dismiss') {
    return buildDecisionDismissExecuteGateSnapshot(command, userId, tenantId);
  }
  return {
    currentEntityVersions: command.preconditions.requiredEntityVersions,
    invariantResults: Object.fromEntries(command.preconditions.invariants.map((invariant) => [invariant.check, true])),
  };
}

function buildTaskCompleteExecuteGateSnapshot(
  command: AICommandEnvelope<Record<string, unknown>>,
  userId: number,
): {
  currentEntityVersions: Record<string, string>;
  invariantResults: Record<string, boolean>;
} {
  const duplicateTargets = taskCompleteTargetsFromPayload(command.payload);
  if (duplicateTargets.length > 1) {
    const currentEntityVersions: Record<string, string> = {};
    let allPending = true;
    for (const target of duplicateTargets) {
      const task = target.taskStore === 'native_tasks'
        ? getNativeTaskForExecution(userId, target.taskId)
        : getTaskForUser(userId, target.taskId);
      const entityId = target.taskStore === 'native_tasks'
        ? `native_task:${target.taskId}`
        : `task:${target.taskId}`;
      if (task) {
        currentEntityVersions[entityId] = computeContentHash(task);
      }
      allPending = allPending && Boolean(task && task.status === 'pending');
    }
    return {
      currentEntityVersions,
      invariantResults: {
        task_is_pending: allPending && Object.keys(currentEntityVersions).length === duplicateTargets.length,
      },
    };
  }

  const taskId = taskIdFromPayload(command.payload);
  if (command.payload.taskStore === 'native_tasks') {
    const task = typeof taskId === 'number' ? getNativeTaskForExecution(userId, taskId) : null;
    const entityId = typeof taskId === 'number' ? `native_task:${taskId}` : undefined;
    const currentEntityVersions = entityId && task
      ? { [entityId]: computeContentHash(task) }
      : {};
    return {
      currentEntityVersions,
      invariantResults: {
        task_is_pending: Boolean(task && task.status === 'pending'),
      },
    };
  }

  const task = typeof taskId === 'number' ? getTaskForUser(userId, taskId) : null;
  const entityId = typeof taskId === 'number' ? `task:${taskId}` : undefined;
  const currentEntityVersions = entityId && task
    ? { [entityId]: computeContentHash(task) }
    : {};
  return {
    currentEntityVersions,
    invariantResults: {
      task_is_pending: Boolean(task && task.status === 'pending'),
    },
  };
}

function getNativeTaskForExecution(userId: number, taskId: number): {
  id: number;
  provider: 'nexus';
  externalId: string;
  projectId: number;
  projectName: string;
  title: string;
  description?: string;
  status: 'pending' | 'completed' | 'in_progress';
  priority: number;
  dueDate?: string;
  dueIsDatetime?: boolean;
  tags?: string[];
  notes?: string;
  completedAt?: string;
  providerData: {
    chatCoreV2TaskStore: 'native_tasks';
    nativeListId: number;
  };
} | null {
  try {
    const row = getDb().prepare(`
      SELECT t.*, l.name AS list_name
      FROM native_tasks t
      JOIN native_task_lists l ON l.id = t.list_id
      WHERE t.user_id = ?
        AND t.id = ?
    `).get(userId, taskId) as {
      id: number;
      list_id: number;
      list_name: string;
      title: string;
      body: string | null;
      importance: string | null;
      status: string;
      due_date_time: string | null;
      tags: string | null;
      completed_at: string | null;
    } | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      provider: 'nexus',
      externalId: String(row.id),
      projectId: Number(row.list_id),
      projectName: row.list_name,
      title: row.title,
      description: row.body ?? undefined,
      status: row.status === 'completed' ? 'completed' : row.status === 'inProgress' ? 'in_progress' : 'pending',
      priority: row.importance === 'high' ? 3 : row.importance === 'normal' ? 2 : 1,
      dueDate: row.due_date_time ?? undefined,
      dueIsDatetime: !!row.due_date_time?.includes('T'),
      tags: parseJsonStringArray(row.tags),
      notes: row.body ?? undefined,
      completedAt: row.completed_at ?? undefined,
      providerData: {
        chatCoreV2TaskStore: 'native_tasks',
        nativeListId: Number(row.list_id),
      },
    };
  } catch {
    return null;
  }
}

function parseJsonStringArray(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : undefined;
  } catch {
    return undefined;
  }
}

function buildNotificationExecuteGateSnapshot(
  command: AICommandEnvelope<Record<string, unknown>>,
  userId: number,
  tenantId: number,
): {
  currentEntityVersions: Record<string, string>;
  invariantResults: Record<string, boolean>;
} {
  const notificationId = notificationIdFromPayload(command.payload);
  const item = notificationId ? getNotificationCenterItem(notificationId, userId, tenantId) : null;
  const entityId = notificationId ? `notification:${notificationId}` : undefined;
  const currentEntityVersions = entityId && item
    ? { [entityId]: notificationSnoozeVersionForItem(item) }
    : {};
  return {
    currentEntityVersions,
    invariantResults: {
      notification_is_snooze_eligible: Boolean(item && isNotificationSnoozeEligibleStatus(item.status)),
    },
  };
}

function buildDecisionDismissExecuteGateSnapshot(
  command: AICommandEnvelope<Record<string, unknown>>,
  userId: number,
  tenantId: number,
): {
  currentEntityVersions: Record<string, string>;
  invariantResults: Record<string, boolean>;
  decisionVersion?: string;
} {
  const decisionId = decisionIdFromPayload(command.payload);
  const item = decisionId ? getDecisionItem(decisionId, userId, tenantId) : null;
  const entityId = decisionId ? `decision:${decisionId}` : undefined;
  const decisionVersion = item ? decisionDismissVersionForItem(item) : undefined;
  const currentEntityVersions = entityId && decisionVersion
    ? { [entityId]: decisionVersion }
    : {};
  return {
    currentEntityVersions,
    decisionVersion,
    invariantResults: {
      decision_is_active: Boolean(item && isDecisionDismissEligibleStatus(item.status)),
    },
  };
}

function emptyExecutionFailure(input: {
  command: AICommandEnvelope<Record<string, unknown>>;
  capabilityId: string;
  gateVerdict: ChatCoreV2CommandGateVerdict;
}): ChatCoreV2CommandExecutionResult {
  return {
    ok: false,
    executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
    commandId: input.command.commandId,
    capabilityId: input.capabilityId,
    gateVerdict: input.gateVerdict,
    status: 'failed',
    reason: 'execution_failed',
  };
}

async function executeTaskComplete(input: {
  command: AICommandEnvelope<Record<string, unknown>>;
  capabilityId: string;
  capability: CapabilityDefinition;
  userId: number;
  tenantId: number;
  locale?: string | null;
  now: Date;
  gateVerdict: ChatCoreV2CommandGateVerdict;
}): Promise<ChatCoreV2CommandExecutionResult> {
  const duplicateTargets = taskCompleteTargetsFromPayload(input.command.payload);
  if (duplicateTargets.length > 1) {
    return executeTaskCompleteBatch(input, duplicateTargets);
  }

  const taskId = taskIdFromPayload(input.command.payload);
  if (typeof taskId !== 'number') {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now);
    return emptyExecutionFailure(input);
  }

  try {
    if (input.command.payload.taskStore === 'native_tasks') {
      return executeNativeTaskComplete(input, taskId);
    }
    await completeTask(input.userId, taskId);
    const readBack = getTaskForUser(input.userId, taskId);
    const verified = Boolean(readBack && readBack.status === 'completed');
    const status: CommandStatus = verified ? 'verified' : 'verification_failed';
    const title = readBack?.title ?? String(input.command.payload.title ?? 'Task');
    const response = buildTaskCompleteResultResponse({
      capability: input.capability,
      command: input.command,
      title,
      taskId,
      status,
      locale: input.locale,
    });

    recordCommandEvent(input.command, input.capabilityId, 'execution_completed', 'executed', undefined, input.now, {
      taskId,
    });
    recordCommandEvent(
      input.command,
      input.capabilityId,
      verified ? 'verification_completed' : 'verification_failed',
      status,
      verified ? undefined : 'verification_failed',
      input.now,
      { taskId },
    );

    return {
      ok: verified,
      executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
      commandId: input.command.commandId,
      capabilityId: input.capabilityId,
      gateVerdict: input.gateVerdict,
      response,
      status,
      reason: verified ? undefined : 'verification_failed',
      completedTaskId: taskId,
    };
  } catch {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now);
    return emptyExecutionFailure(input);
  }
}

type TaskCompleteTarget = {
  taskStore: 'native_tasks' | 'unified_tasks';
  taskId: number;
  nativeListId: number | null;
  title: string;
};

async function executeTaskCompleteBatch(
  input: {
    command: AICommandEnvelope<Record<string, unknown>>;
    capabilityId: string;
    capability: CapabilityDefinition;
    userId: number;
    tenantId: number;
    locale?: string | null;
    now: Date;
    gateVerdict: ChatCoreV2CommandGateVerdict;
  },
  targets: TaskCompleteTarget[],
): Promise<ChatCoreV2CommandExecutionResult> {
  try {
    const completedIds: number[] = [];
    const touchedNativeListIds = new Set<string>();
    for (const target of targets) {
      if (target.taskStore === 'native_tasks') {
        const update = getDb().prepare(`
          UPDATE native_tasks
          SET status = 'completed',
              completed_at = COALESCE(completed_at, datetime('now')),
              updated_at = datetime('now')
          WHERE id = ?
            AND user_id = ?
            AND status <> 'completed'
        `).run(target.taskId, input.userId);
        if (typeof target.nativeListId === 'number') {
          touchedNativeListIds.add(String(target.nativeListId));
        }
        if (update.changes > 0) {
          completedIds.push(target.taskId);
        }
      } else {
        await completeTask(input.userId, target.taskId);
        completedIds.push(target.taskId);
      }
    }

    const verification = await Promise.all(targets.map(async (target) => {
      if (target.taskStore === 'native_tasks') {
        const row = getDb().prepare(`
          SELECT status
          FROM native_tasks
          WHERE id = ?
            AND user_id = ?
        `).get(target.taskId, input.userId) as { status: string } | undefined;
        return row?.status === 'completed' && completedIds.includes(target.taskId);
      }
      const readBack = getTaskForUser(input.userId, target.taskId);
      return readBack?.status === 'completed';
    }));
    const verified = verification.every(Boolean);
    const status: CommandStatus = verified ? 'verified' : 'verification_failed';
    const title = String(input.command.payload.title ?? targets[0]?.title ?? 'Task');
    const response = buildTaskCompleteResultResponse({
      capability: input.capability,
      command: input.command,
      title,
      taskId: targets[0]?.taskId ?? 0,
      taskIds: targets.map((target) => target.taskId),
      completedCount: targets.length,
      status,
      locale: input.locale,
    });

    recordCommandEvent(input.command, input.capabilityId, 'execution_completed', 'executed', undefined, input.now, {
      taskIds: completedIds,
      duplicateTitle: title,
    });
    recordCommandEvent(
      input.command,
      input.capabilityId,
      verified ? 'verification_completed' : 'verification_failed',
      status,
      verified ? undefined : 'verification_failed',
      input.now,
      { taskIds: completedIds, duplicateTitle: title },
    );
    invalidateTaskCaches({
      userId: input.userId,
      listIds: [...touchedNativeListIds],
      includeDerivedSurfaces: true,
    });

    return {
      ok: verified,
      executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
      commandId: input.command.commandId,
      capabilityId: input.capabilityId,
      gateVerdict: input.gateVerdict,
      response,
      status,
      reason: verified ? undefined : 'verification_failed',
      completedTaskId: targets[0]?.taskId,
      completedTaskIds: completedIds,
    };
  } catch {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now);
    return emptyExecutionFailure(input);
  }
}

async function executeTaskCreate(input: {
  command: AICommandEnvelope<Record<string, unknown>>;
  capabilityId: string;
  capability: CapabilityDefinition;
  userId: number;
  tenantId: number;
  locale?: string | null;
  now: Date;
  gateVerdict: ChatCoreV2CommandGateVerdict;
}): Promise<ChatCoreV2CommandExecutionResult> {
  try {
    const payload = taskCreatePayload(input.command.payload);
    const provider = getTaskProviderForUser(input.userId);
    if (typeof provider.createTask !== 'function') {
      throw new Error('task_provider_not_writable');
    }
    const list = await resolveTaskCreationList(provider, payload.projectName ?? null);
    if (!list?.id) throw new Error('missing_task_list');
    const listId = String(list.id);
    const listName = list.displayName || list.name || 'Tasks';

    const created = await provider.createTask(listId, listName, {
      title: payload.title,
      body: payload.notes,
      dueDateTime: payload.dueDate,
    });
    if (!created?.success || !created.data?.id) {
      throw new Error('task_create_failed');
    }

    const createdId = Number(created.data.id);
    const providerTaskId = String(created.data.id);
    const providerListId = String(created.data.listId || listId);
    const addedSubtasks: string[] = [];
    if (payload.subtasks.length > 0) {
      if (typeof provider.addChecklistItem !== 'function' || typeof provider.getChecklistItems !== 'function') {
        throw new Error('task_provider_missing_checklist_support');
      }
      for (const subtask of payload.subtasks) {
        const added = await provider.addChecklistItem(providerListId, providerTaskId, subtask);
        if (!added?.success) {
          throw new Error('task_subtask_create_failed');
        }
        addedSubtasks.push(subtask);
      }
    }
    const readBack = typeof provider.getTask === 'function'
      ? await provider.getTask(providerListId, providerTaskId, listName)
      : null;
    const checklistReadBack = payload.subtasks.length > 0 && typeof provider.getChecklistItems === 'function'
      ? await provider.getChecklistItems(providerListId, providerTaskId)
      : null;
    const readBackTitle = String(
      readBack?.data?.title
      || readBack?.data?.subject
      || created.data.title
      || '',
    ).trim();
    const readBackStatus = String(readBack?.data?.status || created.data.status || '').trim();
    const verifiedSubtasks = payload.subtasks.length === 0 || (
      checklistReadBack?.success !== false
      && subtasksContainAll(checklistItemsToTitles(checklistReadBack?.data), payload.subtasks)
    );
    const verified = (!readBack || readBack.success !== false)
      && readBackTitle === payload.title
      && readBackStatus !== 'completed'
      && verifiedSubtasks;
    const status: CommandStatus = verified ? 'verified' : 'verification_failed';
    const response = buildTaskCreateResultResponse({
      capability: input.capability,
      command: input.command,
      title: payload.title,
      taskId: Number.isInteger(createdId) && createdId > 0 ? createdId : undefined,
      subtasks: payload.subtasks,
      status,
      locale: input.locale,
    });

    recordCommandEvent(input.command, input.capabilityId, 'execution_completed', 'executed', undefined, input.now, {
      taskId: providerTaskId,
      listId: providerListId,
      subtaskCount: addedSubtasks.length,
    });
    recordCommandEvent(
      input.command,
      input.capabilityId,
      verified ? 'verification_completed' : 'verification_failed',
      status,
      verified ? undefined : 'verification_failed',
      input.now,
      { taskId: providerTaskId, listId: providerListId, subtaskCount: addedSubtasks.length },
    );
    invalidateTaskCaches({
      userId: input.userId,
      listIds: [providerListId],
      includeDerivedSurfaces: true,
    });

    return {
      ok: verified,
      executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
      commandId: input.command.commandId,
      capabilityId: input.capabilityId,
      gateVerdict: input.gateVerdict,
      response,
      status,
      reason: verified ? undefined : 'verification_failed',
      createdTaskId: Number.isInteger(createdId) && createdId > 0 ? createdId : undefined,
    };
  } catch {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now);
    return emptyExecutionFailure(input);
  }
}

async function executeNativeTaskComplete(
  input: {
    command: AICommandEnvelope<Record<string, unknown>>;
    capabilityId: string;
    capability: CapabilityDefinition;
    userId: number;
    tenantId: number;
    locale?: string | null;
    now: Date;
    gateVerdict: ChatCoreV2CommandGateVerdict;
  },
  taskId: number,
): Promise<ChatCoreV2CommandExecutionResult> {
  try {
    const update = getDb().prepare(`
      UPDATE native_tasks
      SET status = 'completed',
          completed_at = COALESCE(completed_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
        AND user_id = ?
        AND status <> 'completed'
    `).run(taskId, input.userId);

    const readBack = getDb().prepare(`
      SELECT title, status
      FROM native_tasks
      WHERE id = ?
        AND user_id = ?
    `).get(taskId, input.userId) as { title: string; status: string } | undefined;
    const verified = update.changes > 0 && readBack?.status === 'completed';
    const status: CommandStatus = verified ? 'verified' : 'verification_failed';
    const title = readBack?.title ?? String(input.command.payload.title ?? 'Task');
    const response = buildTaskCompleteResultResponse({
      capability: input.capability,
      command: input.command,
      title,
      taskId,
      status,
      locale: input.locale,
    });

    recordCommandEvent(input.command, input.capabilityId, 'execution_completed', 'executed', undefined, input.now, {
      taskId,
      taskStore: 'native_tasks',
    });
    recordCommandEvent(
      input.command,
      input.capabilityId,
      verified ? 'verification_completed' : 'verification_failed',
      status,
      verified ? undefined : 'verification_failed',
      input.now,
      { taskId, taskStore: 'native_tasks' },
    );
    invalidateTaskCaches({
      userId: input.userId,
      listIds: [String(input.command.payload.listId || input.command.payload.nativeListId || '')],
      includeDerivedSurfaces: true,
    });

    return {
      ok: verified,
      executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
      commandId: input.command.commandId,
      capabilityId: input.capabilityId,
      gateVerdict: input.gateVerdict,
      response,
      status,
      reason: verified ? undefined : 'verification_failed',
      completedTaskId: taskId,
    };
  } catch {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now);
    return emptyExecutionFailure(input);
  }
}

async function executeNotificationSnooze(input: {
  command: AICommandEnvelope<Record<string, unknown>>;
  capabilityId: string;
  capability: CapabilityDefinition;
  userId: number;
  tenantId: number;
  locale?: string | null;
  now: Date;
  gateVerdict: ChatCoreV2CommandGateVerdict;
}): Promise<ChatCoreV2CommandExecutionResult> {
  const notificationId = notificationIdFromPayload(input.command.payload);
  const snoozedUntil = snoozedUntilFromPayload(input.command.payload);
  if (!notificationId || !snoozedUntil) {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now);
    return emptyExecutionFailure(input);
  }

  try {
    const updated = snoozeNotificationCenterItem(notificationId, input.userId, input.tenantId, snoozedUntil);
    const expectedUntil = new Date(Date.parse(snoozedUntil)).toISOString();
    const verified = Boolean(updated && updated.status === 'snoozed' && updated.snoozedUntil === expectedUntil);
    const status: CommandStatus = verified ? 'verified' : 'verification_failed';
    const title = updated?.title ?? String(input.command.payload.title ?? 'Notification');
    const response = buildNotificationSnoozeResultResponse({
      capability: input.capability,
      command: input.command,
      title,
      notificationId,
      snoozedUntil: expectedUntil,
      status,
      locale: input.locale,
    });

    recordCommandEvent(input.command, input.capabilityId, 'execution_completed', 'executed', undefined, input.now, {
      notificationId,
    });
    recordCommandEvent(
      input.command,
      input.capabilityId,
      verified ? 'verification_completed' : 'verification_failed',
      status,
      verified ? undefined : 'verification_failed',
      input.now,
      { notificationId },
    );

    return {
      ok: verified,
      executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
      commandId: input.command.commandId,
      capabilityId: input.capabilityId,
      gateVerdict: input.gateVerdict,
      response,
      status,
      reason: verified ? undefined : 'verification_failed',
      snoozedNotificationId: notificationId,
    };
  } catch {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now);
    return emptyExecutionFailure(input);
  }
}

async function executeDecisionDismiss(input: {
  command: AICommandEnvelope<Record<string, unknown>>;
  capabilityId: string;
  capability: CapabilityDefinition;
  userId: number;
  tenantId: number;
  locale?: string | null;
  now: Date;
  gateVerdict: ChatCoreV2CommandGateVerdict;
}): Promise<ChatCoreV2CommandExecutionResult> {
  const decisionId = decisionIdFromPayload(input.command.payload);
  if (!decisionId) {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now);
    return emptyExecutionFailure(input);
  }

  try {
    const updated = dismissDecision(decisionId, input.userId, input.tenantId);
    const verified = Boolean(updated && updated.status === 'dismissed');
    const status: CommandStatus = verified ? 'verified' : 'verification_failed';
    const title = updated?.title ?? String(input.command.payload.title ?? 'Decision');
    const response = buildDecisionDismissResultResponse({
      capability: input.capability,
      command: input.command,
      title,
      decisionId,
      status,
      locale: input.locale,
    });

    recordCommandEvent(input.command, input.capabilityId, 'execution_completed', 'executed', undefined, input.now, {
      decisionId,
    });
    recordCommandEvent(
      input.command,
      input.capabilityId,
      verified ? 'verification_completed' : 'verification_failed',
      status,
      verified ? undefined : 'verification_failed',
      input.now,
      { decisionId },
    );

    return {
      ok: verified,
      executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
      commandId: input.command.commandId,
      capabilityId: input.capabilityId,
      gateVerdict: input.gateVerdict,
      response,
      status,
      reason: verified ? undefined : 'verification_failed',
      dismissedDecisionId: decisionId,
    };
  } catch {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now);
    return emptyExecutionFailure(input);
  }
}

function taskCreatePayload(payload: Record<string, unknown>): {
  title: string;
  dueDate?: string;
  dueIsDatetime: boolean;
  notes?: string;
  projectName?: string;
  subtasks: string[];
} {
  const title = String(payload.title ?? '').trim();
  const dueDateTime = typeof payload.dueDateTime === 'string' && payload.dueDateTime.trim()
    ? payload.dueDateTime.trim()
    : undefined;
  return {
    title,
    dueDate: dueDateTime,
    dueIsDatetime: Boolean(dueDateTime),
    notes: typeof payload.notes === 'string' ? payload.notes : undefined,
    projectName: typeof payload.list === 'string' ? payload.list : undefined,
    subtasks: Array.isArray(payload.subtasks)
      ? payload.subtasks.map((subtask) => String(subtask).trim()).filter(Boolean).slice(0, 25)
      : [],
  };
}

function checklistItemsToTitles(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      return String(record.displayName ?? record.title ?? record.subject ?? '').trim();
    })
    .filter(Boolean);
}

function normalizeChecklistTitle(value: string): string {
  return value.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function subtasksContainAll(actual: string[], expected: string[]): boolean {
  const actualSet = new Set(actual.map(normalizeChecklistTitle));
  return expected.every((subtask) => actualSet.has(normalizeChecklistTitle(subtask)));
}

function taskIdFromPayload(payload: Record<string, unknown>): number | null {
  const taskId = typeof payload.taskId === 'number'
    ? payload.taskId
    : Number(payload.taskId);
  return Number.isInteger(taskId) && taskId > 0 ? taskId : null;
}

function taskCompleteTargetsFromPayload(payload: Record<string, unknown>): TaskCompleteTarget[] {
  if (!Array.isArray(payload.duplicateTasks)) return [];
  const targets: TaskCompleteTarget[] = [];
  for (const item of payload.duplicateTasks) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const taskId = typeof record.taskId === 'number' ? record.taskId : Number(record.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) continue;
    targets.push({
      taskStore: record.taskStore === 'native_tasks' ? 'native_tasks' : 'unified_tasks',
      taskId,
      nativeListId: typeof record.nativeListId === 'number' ? record.nativeListId : null,
      title: typeof record.title === 'string' ? record.title : String(payload.title ?? 'Task'),
    });
  }
  return targets;
}

function notificationIdFromPayload(payload: Record<string, unknown>): string | null {
  const notificationId = typeof payload.notificationId === 'string' ? payload.notificationId.trim() : '';
  return notificationId ? notificationId : null;
}

function decisionIdFromPayload(payload: Record<string, unknown>): string | null {
  const decisionId = typeof payload.decisionId === 'string' ? payload.decisionId.trim() : '';
  return decisionId ? decisionId : null;
}

function snoozedUntilFromPayload(payload: Record<string, unknown>): string | null {
  if (typeof payload.snoozedUntil !== 'string') return null;
  const parsed = Date.parse(payload.snoozedUntil);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function snoozeMinutesFromPayload(payload: Record<string, unknown>): number {
  const minutes = Number(payload.snoozeMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 60;
}

function buildTaskCreateResultResponse(input: {
  capability: CapabilityDefinition;
  command: AICommandEnvelope<Record<string, unknown>>;
  title: string;
  taskId?: number;
  subtasks?: string[];
  status: CommandStatus;
  locale?: string | null;
}): ChatCoreV2Response {
  const isPT = String(input.locale ?? '').toLowerCase().startsWith('pt');
  const isES = String(input.locale ?? '').toLowerCase().startsWith('es');
  const verified = input.status === 'verified';
  const subtasks = input.subtasks?.map((subtask) => String(subtask).trim()).filter(Boolean) ?? [];
  const summary = verified
    ? subtasks.length > 0
      ? isPT
        ? `Feito — criei a tarefa "${input.title}" com ${subtasks.length} subtarefa(s).`
        : isES
          ? `Listo — creé la tarea "${input.title}" con ${subtasks.length} subtarea(s).`
          : `Done — I created the task "${input.title}" with ${subtasks.length} subtask(s).`
      : isPT
        ? `Feito — criei a tarefa "${input.title}".`
        : isES
          ? `Listo — creé la tarea "${input.title}".`
          : `Done — I created the task "${input.title}".`
    : isPT
      ? `Enviei o pedido, mas ainda não consegui verificar se "${input.title}" foi criada.`
      : isES
        ? `Envié la solicitud, pero todavía no pude verificar si "${input.title}" se creó.`
        : `I sent the request, but I could not verify that "${input.title}" was created yet.`;
  return buildChatCoreV2CommandResultResponse({
    capability: input.capability,
    commandId: input.command.commandId,
    title: verified
      ? isPT ? 'Tarefa criada' : isES ? 'Tarea creada' : 'Task created'
      : isPT ? 'Verificação pendente' : isES ? 'Verificación pendiente' : 'Verification pending',
    summary,
    status: input.status,
    locale: input.locale,
    sourceEntityIds: typeof input.taskId === 'number' ? [`task:${input.taskId}`] : input.command.basedOn.entityIds,
    diff: [
      { label: isPT ? 'Tarefa' : isES ? 'Tarea' : 'Task', after: input.title },
      ...(subtasks.length > 0
        ? [{ label: isPT ? 'Subtarefas' : isES ? 'Subtareas' : 'Subtasks', after: subtasks.join(', ') }]
        : []),
    ],
  });
}

function buildTaskCompleteResultResponse(input: {
  capability: CapabilityDefinition;
  command: AICommandEnvelope<Record<string, unknown>>;
  title: string;
  taskId: number;
  taskIds?: number[];
  completedCount?: number;
  status: CommandStatus;
  locale?: string | null;
}): ChatCoreV2Response {
  const isPT = String(input.locale ?? '').toLowerCase().startsWith('pt');
  const isES = String(input.locale ?? '').toLowerCase().startsWith('es');
  const completedCount = input.completedCount && input.completedCount > 1 ? input.completedCount : 1;
  const verified = input.status === 'verified';
  const summary = verified
    ? completedCount > 1
      ? isPT
        ? `Feito — marquei ${completedCount} tarefas chamadas "${input.title}" como concluídas.`
        : isES
          ? `Listo — marqué ${completedCount} tareas llamadas "${input.title}" como completadas.`
          : `Done — I marked ${completedCount} tasks named "${input.title}" as done.`
      : isPT
        ? `Feito — marquei "${input.title}" como concluída.`
        : isES
          ? `Listo — marqué "${input.title}" como completada.`
          : `Done — I marked "${input.title}" as done.`
    : isPT
      ? `Enviei o pedido, mas ainda não consegui verificar se "${input.title}" foi concluída.`
      : isES
        ? `Envié la solicitud, pero todavía no pude verificar si "${input.title}" se completó.`
        : `I sent the request, but I could not verify that "${input.title}" was completed yet.`;
  const beforeStatus = isPT ? 'Pendente' : isES ? 'Pendiente' : 'Pending';
  const afterStatus = verified
    ? isPT ? 'Concluída' : isES ? 'Completada' : 'Done'
    : isPT ? 'Verificação pendente' : isES ? 'Verificación pendiente' : 'Verification pending';
  return buildChatCoreV2CommandResultResponse({
    capability: input.capability,
    commandId: input.command.commandId,
    title: verified
      ? isPT ? 'Tarefa concluída' : isES ? 'Tarea completada' : 'Task completed'
      : isPT ? 'Verificação pendente' : isES ? 'Verificación pendiente' : 'Verification pending',
    summary,
    status: input.status,
    locale: input.locale,
    sourceEntityIds: (input.taskIds && input.taskIds.length > 0 ? input.taskIds : [input.taskId])
      .map((taskId) => `task:${taskId}`),
    diff: [
      { label: isPT ? 'Tarefa' : isES ? 'Tarea' : 'Task', after: input.title },
      { label: isPT ? 'Estado' : isES ? 'Estado' : 'Status', before: beforeStatus, after: afterStatus },
    ],
  });
}

function buildNotificationSnoozeResultResponse(input: {
  capability: CapabilityDefinition;
  command: AICommandEnvelope<Record<string, unknown>>;
  title: string;
  notificationId: string;
  snoozedUntil: string;
  status: CommandStatus;
  locale?: string | null;
}): ChatCoreV2Response {
  const locale = normalizeChatCoreV2Locale(input.locale);
  const duration = formatSnoozeDuration(snoozeMinutesFromPayload(input.command.payload), locale);
  const copy = notificationSnoozeResultCopy(locale, input.title, duration);
  const statusCopy = notificationStatusCopy(locale);
  return buildChatCoreV2CommandResultResponse({
    capability: input.capability,
    commandId: input.command.commandId,
    title: copy.title,
    summary: copy.summary,
    status: input.status,
    locale,
    sourceEntityIds: [`notification:${input.notificationId}`],
    diff: [
      { label: statusCopy.notification, after: input.title },
      { label: statusCopy.status, before: statusCopy.unread, after: statusCopy.snoozed },
      { label: statusCopy.until, after: input.snoozedUntil },
    ],
  });
}

function buildDecisionDismissResultResponse(input: {
  capability: CapabilityDefinition;
  command: AICommandEnvelope<Record<string, unknown>>;
  title: string;
  decisionId: string;
  status: CommandStatus;
  locale?: string | null;
}): ChatCoreV2Response {
  const locale = normalizeChatCoreV2Locale(input.locale);
  const copy = decisionDismissResultCopy(locale, input.title);
  const labels = decisionStatusCopy(locale);
  return buildChatCoreV2CommandResultResponse({
    capability: input.capability,
    commandId: input.command.commandId,
    title: copy.title,
    summary: copy.summary,
    status: input.status,
    locale,
    sourceEntityIds: [`decision:${input.decisionId}`],
    diff: [
      { label: labels.decision, after: input.title },
      { label: labels.status, before: labels.active, after: labels.dismissed },
      { label: labels.effect, after: labels.removed },
    ],
  });
}

function decisionDismissResultCopy(
  locale: ChatCoreV2Locale,
  title: string,
): { title: string; summary: string } {
  if (locale === 'pt-BR') {
    return {
      title: 'Decisão dispensada',
      summary: `Feito — dispensei "${title}" do Decision Center.`,
    };
  }
  if (locale === 'pt-PT') {
    return {
      title: 'Decisão dispensada',
      summary: `Feito — dispensei "${title}" do Decision Center.`,
    };
  }
  if (locale === 'es') {
    return {
      title: 'Decisión descartada',
      summary: `Listo — descarté "${title}" del Decision Center.`,
    };
  }
  return {
    title: 'Decision dismissed',
    summary: `Done — I dismissed "${title}" from Decision Center.`,
  };
}

function decisionStatusCopy(locale: ChatCoreV2Locale): {
  decision: string;
  status: string;
  effect: string;
  active: string;
  dismissed: string;
  removed: string;
} {
  if (locale === 'pt-BR') {
    return { decision: 'Decisão', status: 'Estado', effect: 'Efeito', active: 'Ativa', dismissed: 'Dispensada', removed: 'Removida da fila ativa' };
  }
  if (locale === 'pt-PT') {
    return { decision: 'Decisão', status: 'Estado', effect: 'Efeito', active: 'Ativa', dismissed: 'Dispensada', removed: 'Removida da fila ativa' };
  }
  if (locale === 'es') {
    return { decision: 'Decisión', status: 'Estado', effect: 'Efecto', active: 'Activa', dismissed: 'Descartada', removed: 'Retirada de la cola activa' };
  }
  return { decision: 'Decision', status: 'Status', effect: 'Effect', active: 'Active', dismissed: 'Dismissed', removed: 'Removed from active queue' };
}

function notificationSnoozeResultCopy(
  locale: ChatCoreV2Locale,
  title: string,
  duration: string,
): { title: string; summary: string } {
  if (locale === 'pt-BR') {
    return {
      title: 'Notificação pausada',
      summary: `Feito — pausei "${title}" por ${duration}.`,
    };
  }
  if (locale === 'pt-PT') {
    return {
      title: 'Notificação pausada',
      summary: `Feito — pausei "${title}" durante ${duration}.`,
    };
  }
  if (locale === 'es') {
    return {
      title: 'Notificación pausada',
      summary: `Listo — pausé "${title}" durante ${duration}.`,
    };
  }
  return {
    title: 'Notification snoozed',
    summary: `Done — I snoozed "${title}" for ${duration}.`,
  };
}

function notificationStatusCopy(locale: ChatCoreV2Locale): {
  notification: string;
  status: string;
  until: string;
  unread: string;
  snoozed: string;
} {
  if (locale === 'pt-BR') {
    return { notification: 'Notificação', status: 'Estado', until: 'Até', unread: 'Não lida', snoozed: 'Pausada' };
  }
  if (locale === 'pt-PT') {
    return { notification: 'Notificação', status: 'Estado', until: 'Até', unread: 'Por ler', snoozed: 'Pausada' };
  }
  if (locale === 'es') {
    return { notification: 'Notificación', status: 'Estado', until: 'Hasta', unread: 'Sin leer', snoozed: 'Pausada' };
  }
  return { notification: 'Notification', status: 'Status', until: 'Until', unread: 'Unread', snoozed: 'Snoozed' };
}

function formatSnoozeDuration(minutes: number, locale: ChatCoreV2Locale): string {
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 60;
  if (safeMinutes % 60 === 0) {
    const hours = safeMinutes / 60;
    if (locale === 'en') return hours === 1 ? '1 hour' : `${hours} hours`;
    if (locale === 'es') return hours === 1 ? '1 hora' : `${hours} horas`;
    return hours === 1 ? '1 hora' : `${hours} horas`;
  }
  if (locale === 'en') return safeMinutes === 1 ? '1 minute' : `${safeMinutes} minutes`;
  if (locale === 'es') return safeMinutes === 1 ? '1 minuto' : `${safeMinutes} minutos`;
  return safeMinutes === 1 ? '1 minuto' : `${safeMinutes} minutos`;
}

function recordCommandEvent(
  command: AICommandEnvelope<Record<string, unknown>>,
  capabilityId: string,
  eventName: Parameters<typeof recordChatV2CommandEvent>[0]['eventName'],
  status: CommandStatus,
  reason: string | undefined,
  now: Date,
  metadata: Record<string, unknown> = {},
): void {
  recordChatV2CommandEvent({
    commandEventId: `${command.commandId}:${eventName}`,
    turnId: command.basedOn.contextHash,
    commandId: command.commandId,
    tenantId: command.tenantId,
    userId: command.userId,
    domain: command.domain,
    commandType: command.commandType,
    eventName,
    status,
    origin: command.origin,
    capabilityId,
    idempotencyKey: command.idempotencyKey,
    reason,
    redactedSummary: `${command.commandType} ${eventName}`,
    metadata: {
      executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
      ...metadata,
    },
    createdAt: now.toISOString(),
  });
}
