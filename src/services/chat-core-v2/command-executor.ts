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
  decisionActionVersionForItem,
  decisionDismissVersionForItem,
  decisionSnoozeVersionForItem,
  isDecisionDismissEligibleStatus,
  isDecisionSnoozeEligibleStatus,
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
import { isSingleWritePathEnabled } from '../task-store/single-write-path';
import { importanceToPriority } from '../task-store/task-priority';
import {
  addOfflineTaskChecklistItem,
  createOfflineFirstTask,
  getOfflineTaskById,
  recordLocalTaskMutation,
  resolveOfflineCaptureListName,
  resolveOfflineNexusTaskId,
} from '../task-store/offline-first-task-service';
import { invalidateTaskCaches } from '../cache-coherence-registry';
import { computeContentHash } from '../task-store/unified-task-store';
import {
  getNotificationCenterItem,
  snoozeNotificationCenterItem,
} from '../notification-orchestrator';
import {
  dismissDecision,
  getDecisionItem,
  snoozeDecision,
} from '../decision-center';
import {
  contentApprovalVersionForObject,
  directOwnedContentObjectForDecision,
  executeDecisionChatFixerProjection,
  executeDecisionContentCommand,
} from '../decision-command-effects';
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
  | 'execution_uncertain'
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
  /**
   * M5 single write path: the created task's NEXUS id (ledger identity — the
   * id the REST read model and follow-up actions speak). createdTaskId keeps
   * its legacy numeric-row-id semantics for the flag-off path.
   */
  createdTaskNexusId?: string;
  completedTaskId?: number;
  completedTaskIds?: number[];
  snoozedNotificationId?: string;
  dismissedDecisionId?: string;
  snoozedDecisionId?: string;
  actionedDecisionId?: string;
  contentObjectId?: number;
  contentApprovalState?: 'approved' | 'rejected';
  freshConfirmationRequired?: boolean;
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
    // Recompute the permission contract from authenticated execution scope and
    // the current server capability. Comparing the envelope to its own stored
    // authorization value would be tautological and could never detect a stale
    // permission contract. Resource ownership remains enforced by the scoped
    // domain reads in buildExecuteGateSnapshot and the domain executor itself.
    permissionSnapshotVersion: currentPermissionSnapshotVersion(
      input.command,
      input.capabilityId,
      input.userId,
      input.tenantId,
    ),
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
  if (input.command.commandType === 'decision_center.snooze') {
    return executeDecisionSnooze({
      ...input,
      capability,
      gateVerdict,
      now,
    });
  }
  if (input.command.commandType === 'content.approve_script'
      || input.command.commandType === 'content.request_rewrite') {
    return executeDecisionContentApproval({
      ...input,
      capability,
      gateVerdict,
      now,
    });
  }
  if (input.command.commandType === 'decision_center.accept_chat_action_fix') {
    return executeDecisionChatFixerAcceptance({
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

function currentPermissionSnapshotVersion(
  command: AICommandEnvelope<Record<string, unknown>>,
  capabilityId: string,
  userId: number,
  tenantId: number,
): string {
  return command.origin === 'decision_center'
    ? `decision-center-permissions:${tenantId}:${userId}:${capabilityId}:v1`
    : `chat-v2-permissions:${tenantId}:${userId}:${command.domain}:v1`;
}

export function isExecutableCommandType(commandType: string): boolean {
  return commandType === 'tasks.create'
    || commandType === 'tasks.complete'
    || commandType === 'notifications.snooze'
    || commandType === 'decision_center.dismiss'
    || commandType === 'decision_center.snooze'
    || commandType === 'content.approve_script'
    || commandType === 'content.request_rewrite'
    || commandType === 'decision_center.accept_chat_action_fix';
}

/**
 * The sync command types the executor can actually run. Each one performs an
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
  'decision_center.snooze',
  'content.approve_script',
  'content.request_rewrite',
  'decision_center.accept_chat_action_fix',
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
  if (command.commandType === 'decision_center.snooze') {
    return buildDecisionSnoozeExecuteGateSnapshot(command, userId, tenantId);
  }
  if (command.commandType === 'content.approve_script'
      || command.commandType === 'content.request_rewrite') {
    return buildDecisionContentExecuteGateSnapshot(command, userId, tenantId);
  }
  if (command.commandType === 'decision_center.accept_chat_action_fix') {
    return buildDecisionChatFixerExecuteGateSnapshot(command, userId, tenantId);
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
      // M10 P-scale (NEX-17): shared inbound table (high→2, normal→3, low→4).
      priority: importanceToPriority(row.importance),
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

function buildDecisionSnoozeExecuteGateSnapshot(
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
  const decisionVersion = item ? decisionSnoozeVersionForItem(item) : undefined;
  const currentEntityVersions = entityId && decisionVersion
    ? { [entityId]: decisionVersion }
    : {};
  return {
    currentEntityVersions,
    decisionVersion,
    invariantResults: {
      decision_is_snooze_eligible: Boolean(item && isDecisionSnoozeEligibleStatus(item.status)),
    },
  };
}

function buildDecisionContentExecuteGateSnapshot(
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
  const object = item ? directOwnedContentObjectForDecision(item, userId, tenantId) : null;
  const expectedObjectId = contentObjectIdFromPayload(command.payload);
  const decisionEntityId = decisionId ? `decision:${decisionId}` : undefined;
  const contentEntityId = object ? `content_workflow_object:${object.id}` : undefined;
  const decisionVersion = item ? decisionActionVersionForItem(item) : undefined;
  const currentEntityVersions: Record<string, string> = {};
  if (decisionEntityId && decisionVersion) currentEntityVersions[decisionEntityId] = decisionVersion;
  if (contentEntityId && object) currentEntityVersions[contentEntityId] = contentApprovalVersionForObject(object);
  const actionId = command.commandType === 'content.approve_script' ? 'approve_script' : 'request_rewrite';
  return {
    currentEntityVersions,
    decisionVersion,
    invariantResults: {
      decision_is_active: Boolean(item
        && isDecisionDismissEligibleStatus(item.status)
        && item.actions.some((action) => action.id === actionId)),
      content_object_is_direct_private_owner_target: Boolean(
        object && expectedObjectId === object.id,
      ),
    },
  };
}

function buildDecisionChatFixerExecuteGateSnapshot(
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
  const decisionEntityId = decisionId ? `decision:${decisionId}` : undefined;
  const decisionVersion = item ? decisionActionVersionForItem(item) : undefined;
  const currentEntityVersions = decisionEntityId && decisionVersion
    ? { [decisionEntityId]: decisionVersion }
    : {};
  const anchoredFixer = Boolean(item
    && item.sourceSkill === 'chat'
    && item.relatedEntities.some((entity) => entity.type === 'chat_action_fixer_review' && !!entity.id)
    && item.actions.some((action) => action.id === 'accept_chat_action_fix'));
  return {
    currentEntityVersions,
    decisionVersion,
    invariantResults: {
      decision_is_active: Boolean(item && isDecisionDismissEligibleStatus(item.status)),
      chat_fixer_is_projection_only: anchoredFixer
        && command.payload.providerActionExecuted === false
        && command.payload.freshConfirmationRequired === true,
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
    if (isSingleWritePathEnabled()) {
      completeUnifiedTaskViaLedger(input.tenantId, input.userId, taskId);
    } else {
      // Legacy direct path (TASK_SINGLE_WRITE_PATH=0): task-service resolves
      // the row to its provider and writes the provider synchronously.
      await completeTask(input.userId, taskId);
    }
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
        if (isSingleWritePathEnabled()) {
          completeUnifiedTaskViaLedger(input.tenantId, input.userId, target.taskId);
        } else {
          // Legacy direct path (TASK_SINGLE_WRITE_PATH=0).
          await completeTask(input.userId, target.taskId);
        }
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
  return isSingleWritePathEnabled()
    ? executeTaskCreateViaLedger(input)
    : executeTaskCreateLegacy(input);
}

/**
 * M5 ledger create: the task is written to the offline-first ledger (instant
 * Tasks-tab visibility — NEX-08) and the provider push runs asynchronously on
 * the mutation worker. Verification is a deterministic local read-back.
 * Reported ids are NEXUS task ids — what the REST read model and follow-up
 * chat actions speak; the provider id only exists after the async push.
 */
async function executeTaskCreateViaLedger(input: {
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
    const created = createOfflineFirstTask(input.tenantId, input.userId, {
      title: payload.title,
      body: payload.notes,
      dueDateTime: payload.dueDate,
      listName: resolveOfflineCaptureListName(input.tenantId, input.userId, payload.projectName),
    });
    const nexusTaskId = created.task.id;
    const addedSubtasks: string[] = [];
    for (const subtask of payload.subtasks) {
      addOfflineTaskChecklistItem(input.tenantId, input.userId, {
        taskId: nexusTaskId,
        displayName: subtask,
      });
      addedSubtasks.push(subtask);
    }
    const readBack = getOfflineTaskById(input.tenantId, input.userId, nexusTaskId);
    const listId = String(readBack?.listId ?? created.task.listId ?? '');
    const verifiedSubtasks = payload.subtasks.length === 0
      || subtasksContainAll((readBack?.checklistItems || []).map((item) => item.displayName), payload.subtasks);
    const verified = !!readBack
      && readBack.title === payload.title
      && readBack.status !== 'completed'
      && verifiedSubtasks;
    const status: CommandStatus = verified ? 'verified' : 'verification_failed';
    const response = buildTaskCreateResultResponse({
      capability: input.capability,
      command: input.command,
      title: payload.title,
      // Nexus task ids are not numeric row ids, so createdTaskId stays
      // undefined — same as the provider-id behavior of the legacy MS path.
      taskId: undefined,
      subtasks: payload.subtasks,
      status,
      locale: input.locale,
    });

    recordCommandEvent(input.command, input.capabilityId, 'execution_completed', 'executed', undefined, input.now, {
      taskId: nexusTaskId,
      listId,
      subtaskCount: addedSubtasks.length,
    });
    recordCommandEvent(
      input.command,
      input.capabilityId,
      verified ? 'verification_completed' : 'verification_failed',
      status,
      verified ? undefined : 'verification_failed',
      input.now,
      { taskId: nexusTaskId, listId, subtaskCount: addedSubtasks.length },
    );
    invalidateTaskCaches({
      userId: input.userId,
      listIds: listId ? [listId] : [],
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
      createdTaskId: undefined,
      createdTaskNexusId: nexusTaskId,
    };
  } catch {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now);
    return emptyExecutionFailure(input);
  }
}

/**
 * Legacy direct-provider create (TASK_SINGLE_WRITE_PATH=0 revert lever):
 * writes the provider synchronously and verifies via provider read-back.
 */
async function executeTaskCreateLegacy(input: {
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
    const readBackData = readBack
      && readBack.success !== false
      && readBack.data
      && typeof readBack.data === 'object'
      && !Array.isArray(readBack.data)
      ? readBack.data as Record<string, unknown>
      : null;
    const readBackId = String(
      readBackData?.id
      ?? readBackData?.taskId
      ?? readBackData?.externalId
      ?? '',
    ).trim();
    const readBackTitle = String(readBackData?.title || readBackData?.subject || '').trim();
    const readBackStatus = String(readBackData?.status || '').trim();
    const verifiedSubtasks = payload.subtasks.length === 0 || (
      checklistReadBack?.success !== false
      && subtasksContainAll(checklistItemsToTitles(checklistReadBack?.data), payload.subtasks)
    );
    const hasIndependentReadBack = !!readBackData
      && readBackId.length > 0
      && readBackId === providerTaskId;
    const verified = hasIndependentReadBack
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
    const current = getDecisionItem(decisionId, input.userId, input.tenantId);
    if (!current) throw new Error('DECISION_NOT_AVAILABLE');
    const updated = dismissDecision(
      decisionId,
      input.userId,
      input.tenantId,
      undefined,
      current.recordVersion,
      { actionId: 'dismiss', idempotencyKey: input.command.idempotencyKey },
    );
    // Dismissed rows may disappear from the active read model. Null is
    // therefore a valid terminal read-back after the scoped CAS, while an
    // explicitly active row proves the projection did not settle.
    const readBack = getDecisionItem(decisionId, input.userId, input.tenantId);
    const verified = updated.status === 'dismissed'
      && (readBack == null || readBack.status === 'dismissed');
    const status: CommandStatus = verified ? 'verified' : 'verification_failed';
    const title = updated.title ?? String(input.command.payload.title ?? 'Decision');
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

async function executeDecisionSnooze(input: {
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
    const minutes = snoozeMinutesFromPayload(input.command.payload);
    const current = getDecisionItem(decisionId, input.userId, input.tenantId);
    if (!current) throw new Error('DECISION_NOT_AVAILABLE');
    const updated = snoozeDecision(
      decisionId,
      input.userId,
      input.tenantId,
      minutes,
      current.recordVersion,
      { actionId: 'snooze', idempotencyKey: input.command.idempotencyKey },
    );
    const readBack = getDecisionItem(decisionId, input.userId, input.tenantId);
    const verified = Boolean(readBack && readBack.status === 'snoozed');
    const status: CommandStatus = verified ? 'verified' : 'verification_failed';
    const title = readBack?.title ?? updated?.title ?? String(input.command.payload.title ?? 'Decision');
    const response = buildDecisionSnoozeResultResponse({
      capability: input.capability,
      command: input.command,
      title,
      decisionId,
      snoozedUntil: readBack?.snoozedUntil ?? String(input.command.payload.snoozedUntil ?? ''),
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
      snoozedDecisionId: decisionId,
    };
  } catch {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now);
    return emptyExecutionFailure(input);
  }
}

async function executeDecisionContentApproval(input: {
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
  const contentObjectId = contentObjectIdFromPayload(input.command.payload);
  const actionId = input.command.commandType === 'content.approve_script' ? 'approve_script' : 'request_rewrite';
  const contentEntityId = contentObjectId ? `content_workflow_object:${contentObjectId}` : null;
  const expectedContentVersion = contentEntityId
    ? input.command.preconditions.requiredEntityVersions[contentEntityId]
    : undefined;
  if (!decisionId || !contentObjectId || !expectedContentVersion) {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now);
    return emptyExecutionFailure(input);
  }

  let committed: ReturnType<typeof executeDecisionContentCommand> | null = null;
  try {
    const item = getDecisionItem(decisionId, input.userId, input.tenantId);
    if (!item) throw new Error('DECISION_NOT_AVAILABLE');
    const execution = executeDecisionContentCommand({
      item,
      actionId,
      userId: input.userId,
      tenantId: input.tenantId,
      expectedContentVersion,
    });
    committed = execution;
    const status: CommandStatus = 'verified';
    const response = buildDecisionDomainActionResultResponse({
      capability: input.capability,
      command: input.command,
      title: item.safePreviewTitle || item.title,
      decisionId,
      contentObjectId,
      actionId,
      status,
      locale: input.locale,
    });
    recordCommandEvent(input.command, input.capabilityId, 'execution_completed', 'executed', undefined, input.now, {
      decisionId,
      contentObjectId,
      actionId,
    });
    recordCommandEvent(input.command, input.capabilityId, 'verification_completed', status, undefined, input.now, {
      decisionId,
      contentObjectId,
      actionId,
    });
    return {
      ok: true,
      executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
      commandId: input.command.commandId,
      capabilityId: input.capabilityId,
      gateVerdict: input.gateVerdict,
      response,
      status,
      actionedDecisionId: execution.decisionId,
      contentObjectId: execution.contentObjectId,
      contentApprovalState: execution.contentApprovalState,
    };
  } catch {
    if (committed) {
      try {
        recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'partially_failed', 'execution_uncertain', input.now, {
          decisionId,
          contentObjectId,
          actionId,
        });
      } catch {
        // The source transaction committed. A second audit failure must not
        // downgrade the outcome to a definite failure.
      }
      return {
        ok: false,
        executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
        commandId: input.command.commandId,
        capabilityId: input.capabilityId,
        gateVerdict: input.gateVerdict,
        status: 'partially_failed',
        reason: 'execution_uncertain',
        actionedDecisionId: committed.decisionId,
        contentObjectId: committed.contentObjectId,
        contentApprovalState: committed.contentApprovalState,
      };
    }
    try {
      recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now, {
        decisionId,
        contentObjectId,
        actionId,
      });
    } catch {
      // Preserve the original definite pre-commit failure classification.
    }
    return emptyExecutionFailure(input);
  }
}

async function executeDecisionChatFixerAcceptance(input: {
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
    const item = getDecisionItem(decisionId, input.userId, input.tenantId);
    if (!item) throw new Error('DECISION_NOT_AVAILABLE');
    const execution = executeDecisionChatFixerProjection({
      item,
      userId: input.userId,
      tenantId: input.tenantId,
    });
    const status: CommandStatus = 'verified';
    const response = buildDecisionDomainActionResultResponse({
      capability: input.capability,
      command: input.command,
      title: item.safePreviewTitle || item.title,
      decisionId,
      actionId: 'accept_chat_action_fix',
      status,
      locale: input.locale,
    });
    recordCommandEvent(input.command, input.capabilityId, 'execution_completed', 'executed', undefined, input.now, {
      decisionId,
      providerActionExecuted: false,
    });
    recordCommandEvent(input.command, input.capabilityId, 'verification_completed', status, undefined, input.now, {
      decisionId,
      providerActionExecuted: false,
    });
    return {
      ok: true,
      executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
      commandId: input.command.commandId,
      capabilityId: input.capabilityId,
      gateVerdict: input.gateVerdict,
      response,
      status,
      actionedDecisionId: execution.decisionId,
      freshConfirmationRequired: execution.actionResult.freshConfirmationRequired === true,
    };
  } catch {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now, {
      decisionId,
      providerActionExecuted: false,
    });
    return emptyExecutionFailure(input);
  }
}

/**
 * M5 ledger complete for unified-store tasks: journal `task.complete` against
 * the nexus task resolved from the command's numeric row id. The local row
 * flips to completed immediately (so getTaskForUser read-back verification
 * still holds) and the provider write happens asynchronously on the mutation
 * worker — the next pull can no longer revert the completion (NEX-09).
 */
function completeUnifiedTaskViaLedger(tenantId: number, userId: number, taskId: number): void {
  const nexusTaskId = resolveOfflineNexusTaskId(tenantId, userId, String(taskId));
  if (!nexusTaskId) throw new Error(`Task ${taskId} not found in local task store`);
  recordLocalTaskMutation(tenantId, userId, {
    taskId: nexusTaskId,
    operation: 'task.complete',
    patch: { source: 'chat_core_v2_command' },
  });
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

function contentObjectIdFromPayload(payload: Record<string, unknown>): number | null {
  const contentObjectId = typeof payload.contentObjectId === 'number'
    ? payload.contentObjectId
    : Number(payload.contentObjectId);
  return Number.isInteger(contentObjectId) && contentObjectId > 0 ? contentObjectId : null;
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
  const verified = input.status === 'verified';
  const copy = decisionDismissResultCopy(locale, input.title, verified);
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
      { label: labels.status, before: labels.active, after: verified ? labels.dismissed : labels.verificationPending },
      { label: labels.effect, after: verified ? labels.removed : labels.verificationPendingEffect },
    ],
  });
}

function buildDecisionSnoozeResultResponse(input: {
  capability: CapabilityDefinition;
  command: AICommandEnvelope<Record<string, unknown>>;
  title: string;
  decisionId: string;
  snoozedUntil: string;
  status: CommandStatus;
  locale?: string | null;
}): ChatCoreV2Response {
  const locale = normalizeChatCoreV2Locale(input.locale);
  const verified = input.status === 'verified';
  const duration = formatSnoozeDuration(snoozeMinutesFromPayload(input.command.payload), locale);
  const copy = decisionSnoozeResultCopy(locale, input.title, duration, verified);
  const labels = decisionSnoozeStatusCopy(locale);
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
      { label: labels.status, before: labels.active, after: verified ? labels.snoozed : labels.verificationPending },
      { label: labels.until, after: input.snoozedUntil || labels.verificationPendingEffect },
    ],
  });
}

function buildDecisionDomainActionResultResponse(input: {
  capability: CapabilityDefinition;
  command: AICommandEnvelope<Record<string, unknown>>;
  title: string;
  decisionId: string;
  contentObjectId?: number;
  actionId: 'approve_script' | 'request_rewrite' | 'accept_chat_action_fix';
  status: CommandStatus;
  locale?: string | null;
}): ChatCoreV2Response {
  const locale = normalizeChatCoreV2Locale(input.locale);
  const verified = input.status === 'verified';
  const copy = decisionDomainActionCopy(locale, input.actionId, input.title, verified);
  const labels = decisionStatusCopy(locale);
  const sourceEntityIds = [
    `decision:${input.decisionId}`,
    ...(input.contentObjectId ? [`content_workflow_object:${input.contentObjectId}`] : []),
  ];
  return buildChatCoreV2CommandResultResponse({
    capability: input.capability,
    commandId: input.command.commandId,
    title: copy.title,
    summary: copy.summary,
    status: input.status,
    locale,
    sourceEntityIds,
    diff: [
      { label: labels.decision, after: input.title },
      {
        label: labels.status,
        before: labels.active,
        after: verified ? copy.afterStatus : labels.verificationPending,
      },
      { label: labels.effect, after: verified ? copy.effect : labels.verificationPendingEffect },
    ],
  });
}

function decisionDomainActionCopy(
  locale: ChatCoreV2Locale,
  actionId: 'approve_script' | 'request_rewrite' | 'accept_chat_action_fix',
  title: string,
  verified: boolean,
): { title: string; summary: string; afterStatus: string; effect: string } {
  const isPT = locale === 'pt-BR' || locale === 'pt-PT';
  if (actionId === 'approve_script') {
    return isPT
      ? {
        title: verified ? 'Conteúdo aprovado' : 'Verificação pendente',
        summary: verified ? `Feito — aprovei "${title}".` : `Ainda não consegui confirmar a aprovação de "${title}".`,
        afterStatus: 'Aprovado',
        effect: 'Aprovação confirmada na origem',
      }
      : locale === 'es'
        ? {
          title: verified ? 'Contenido aprobado' : 'Verificación pendiente',
          summary: verified ? `Listo — aprobé "${title}".` : `Todavía no pude confirmar la aprobación de "${title}".`,
          afterStatus: 'Aprobado',
          effect: 'Aprobación confirmada en el origen',
        }
        : {
          title: verified ? 'Content approved' : 'Verification pending',
          summary: verified ? `Done — I approved "${title}".` : `I could not confirm approval of "${title}" yet.`,
          afterStatus: 'Approved',
          effect: 'Approval confirmed in source state',
        };
  }
  if (actionId === 'request_rewrite') {
    return isPT
      ? {
        title: verified ? 'Alterações pedidas' : 'Verificação pendente',
        summary: verified ? `Feito — pedi alterações para "${title}".` : `Ainda não consegui confirmar o pedido de alterações para "${title}".`,
        afterStatus: 'Alterações pedidas',
        effect: 'Pedido confirmado na origem',
      }
      : locale === 'es'
        ? {
          title: verified ? 'Cambios solicitados' : 'Verificación pendiente',
          summary: verified ? `Listo — pedí cambios para "${title}".` : `Todavía no pude confirmar los cambios para "${title}".`,
          afterStatus: 'Cambios solicitados',
          effect: 'Solicitud confirmada en el origen',
        }
        : {
          title: verified ? 'Changes requested' : 'Verification pending',
          summary: verified ? `Done — I requested changes for "${title}".` : `I could not confirm the change request for "${title}" yet.`,
          afterStatus: 'Changes requested',
          effect: 'Request confirmed in source state',
        };
  }
  return isPT
    ? {
      title: verified ? 'Correção aceite' : 'Verificação pendente',
      summary: verified
        ? `Aceitei a correção para "${title}". Nenhuma ação externa foi executada; a próxima tentativa exige nova confirmação.`
        : `Ainda não consegui confirmar a correção para "${title}".`,
      afterStatus: 'Correção aceite',
      effect: 'Registo atualizado sem ação externa',
    }
    : locale === 'es'
      ? {
        title: verified ? 'Corrección aceptada' : 'Verificación pendiente',
        summary: verified
          ? `Acepté la corrección para "${title}". No se ejecutó ninguna acción externa; el siguiente intento requiere una nueva confirmación.`
          : `Todavía no pude confirmar la corrección para "${title}".`,
        afterStatus: 'Corrección aceptada',
        effect: 'Registro actualizado sin acción externa',
      }
      : {
        title: verified ? 'Correction accepted' : 'Verification pending',
        summary: verified
          ? `I accepted the correction for "${title}". No provider action ran; a fresh confirmation is required before any retry.`
          : `I could not confirm the correction for "${title}" yet.`,
        afterStatus: 'Correction accepted',
        effect: 'Review state recorded without a provider action',
      };
}

function decisionDismissResultCopy(
  locale: ChatCoreV2Locale,
  title: string,
  verified: boolean,
): { title: string; summary: string } {
  if (locale === 'pt-BR') {
    return {
      title: verified ? 'Decisão dispensada' : 'Verificação pendente',
      summary: verified
        ? `Feito — dispensei "${title}" do Decision Center.`
        : `Enviei o pedido, mas ainda não consegui verificar se "${title}" foi dispensada do Decision Center.`,
    };
  }
  if (locale === 'pt-PT') {
    return {
      title: verified ? 'Decisão dispensada' : 'Verificação pendente',
      summary: verified
        ? `Feito — dispensei "${title}" do Decision Center.`
        : `Enviei o pedido, mas ainda não consegui verificar se "${title}" foi dispensada do Decision Center.`,
    };
  }
  if (locale === 'es') {
    return {
      title: verified ? 'Decisión descartada' : 'Verificación pendiente',
      summary: verified
        ? `Listo — descarté "${title}" del Decision Center.`
        : `Envié la solicitud, pero todavía no pude verificar si "${title}" se descartó del Decision Center.`,
    };
  }
  return {
    title: verified ? 'Decision dismissed' : 'Verification pending',
    summary: verified
      ? `Done — I dismissed "${title}" from Decision Center.`
      : `I sent the request, but I could not verify that "${title}" was dismissed from Decision Center yet.`,
  };
}

function decisionStatusCopy(locale: ChatCoreV2Locale): {
  decision: string;
  status: string;
  effect: string;
  active: string;
  dismissed: string;
  removed: string;
  verificationPending: string;
  verificationPendingEffect: string;
} {
  if (locale === 'pt-BR') {
    return { decision: 'Decisão', status: 'Estado', effect: 'Efeito', active: 'Ativa', dismissed: 'Dispensada', removed: 'Removida da fila ativa', verificationPending: 'Verificação pendente', verificationPendingEffect: 'Sem confirmação de remoção' };
  }
  if (locale === 'pt-PT') {
    return { decision: 'Decisão', status: 'Estado', effect: 'Efeito', active: 'Ativa', dismissed: 'Dispensada', removed: 'Removida da fila ativa', verificationPending: 'Verificação pendente', verificationPendingEffect: 'Sem confirmação de remoção' };
  }
  if (locale === 'es') {
    return { decision: 'Decisión', status: 'Estado', effect: 'Efecto', active: 'Activa', dismissed: 'Descartada', removed: 'Retirada de la cola activa', verificationPending: 'Verificación pendiente', verificationPendingEffect: 'Sin confirmación de retirada' };
  }
  return { decision: 'Decision', status: 'Status', effect: 'Effect', active: 'Active', dismissed: 'Dismissed', removed: 'Removed from active queue', verificationPending: 'Verification pending', verificationPendingEffect: 'Removal not confirmed' };
}

function decisionSnoozeResultCopy(
  locale: ChatCoreV2Locale,
  title: string,
  duration: string,
  verified: boolean,
): { title: string; summary: string } {
  if (locale === 'pt-BR') {
    return {
      title: verified ? 'Decisão adiada' : 'Verificação pendente',
      summary: verified
        ? `Feito — adiei "${title}" no Decision Center por ${duration}.`
        : `Enviei o pedido, mas ainda não consegui verificar se "${title}" foi adiada no Decision Center.`,
    };
  }
  if (locale === 'pt-PT') {
    return {
      title: verified ? 'Decisão adiada' : 'Verificação pendente',
      summary: verified
        ? `Feito — adiei "${title}" no Decision Center durante ${duration}.`
        : `Enviei o pedido, mas ainda não consegui verificar se "${title}" foi adiada no Decision Center.`,
    };
  }
  if (locale === 'es') {
    return {
      title: verified ? 'Decisión pausada' : 'Verificación pendiente',
      summary: verified
        ? `Listo — pausé "${title}" en Decision Center durante ${duration}.`
        : `Envié la solicitud, pero todavía no pude verificar si "${title}" se pausó en Decision Center.`,
    };
  }
  return {
    title: verified ? 'Decision snoozed' : 'Verification pending',
    summary: verified
      ? `Done — I snoozed "${title}" in Decision Center for ${duration}.`
      : `I sent the request, but I could not verify that "${title}" was snoozed in Decision Center yet.`,
  };
}

function decisionSnoozeStatusCopy(locale: ChatCoreV2Locale): {
  decision: string;
  status: string;
  until: string;
  active: string;
  snoozed: string;
  verificationPending: string;
  verificationPendingEffect: string;
} {
  if (locale === 'pt-BR') {
    return { decision: 'Decisão', status: 'Estado', until: 'Até', active: 'Ativa', snoozed: 'Adiada', verificationPending: 'Verificação pendente', verificationPendingEffect: 'Sem confirmação de adiamento' };
  }
  if (locale === 'pt-PT') {
    return { decision: 'Decisão', status: 'Estado', until: 'Até', active: 'Ativa', snoozed: 'Adiada', verificationPending: 'Verificação pendente', verificationPendingEffect: 'Sem confirmação de adiamento' };
  }
  if (locale === 'es') {
    return { decision: 'Decisión', status: 'Estado', until: 'Hasta', active: 'Activa', snoozed: 'Pausada', verificationPending: 'Verificación pendiente', verificationPendingEffect: 'Sin confirmación de pausa' };
  }
  return { decision: 'Decision', status: 'Status', until: 'Until', active: 'Active', snoozed: 'Snoozed', verificationPending: 'Verification pending', verificationPendingEffect: 'Snooze not confirmed' };
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
