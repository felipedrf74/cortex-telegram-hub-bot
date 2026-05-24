// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  evaluateChatCoreV2CommandBusGate,
  type ChatCoreV2CommandGateVerdict,
} from './command-bus';
import {
  getChatCoreV2Capability,
} from './capability-registry';
import {
  buildChatCoreV2CommandResultResponse,
  type ChatCoreV2Response,
} from './response-contracts';
import {
  recordChatV2CommandEvent,
} from './command-events';
import {
  completeTask,
  createTask,
  getTask,
} from '../task-store/task-service';
import { computeContentHash } from '../task-store/unified-task-store';
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
  const executeSnapshot = buildExecuteGateSnapshot(input.command);
  const gateVerdict = evaluateChatCoreV2CommandBusGate(input.command, {
    actorUserId: String(input.userId),
    tenantId: String(input.tenantId),
    delegatedScopes: input.command.authorization.delegatedScopes,
    permissionSnapshotVersion: input.command.authorization.permissionSnapshotVersion,
    currentEntityVersions: executeSnapshot.currentEntityVersions,
    decisionVersion: input.command.preconditions.requiredDecisionVersion,
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

  try {
    const createdTask = await createTask(input.userId, taskCreatePayload(input.command.payload));
    const readBack = typeof createdTask.id === 'number' ? getTask(createdTask.id) : null;
    const verified = Boolean(readBack && readBack.title === createdTask.title && readBack.status === 'pending');
    const status: CommandStatus = verified ? 'verified' : 'verification_failed';
    const response = buildTaskCreateResultResponse({
      capability,
      command: input.command,
      title: createdTask.title,
      taskId: createdTask.id,
      status,
      locale: input.locale,
    });

    recordCommandEvent(input.command, input.capabilityId, 'execution_completed', 'executed', undefined, now, {
      taskId: createdTask.id ?? null,
    });
    recordCommandEvent(
      input.command,
      input.capabilityId,
      verified ? 'verification_completed' : 'verification_failed',
      status,
      verified ? undefined : 'verification_failed',
      now,
      { taskId: createdTask.id ?? null },
    );

    return {
      ok: verified,
      executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
      commandId: input.command.commandId,
      capabilityId: input.capabilityId,
      gateVerdict,
      response,
      status,
      reason: verified ? undefined : 'verification_failed',
      createdTaskId: createdTask.id,
    };
  } catch {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', now);
    return {
      ok: false,
      executorVersion: CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION,
      commandId: input.command.commandId,
      capabilityId: input.capabilityId,
      gateVerdict,
      status: 'failed',
      reason: 'execution_failed',
    };
  }
}

function isExecutableCommandType(commandType: string): boolean {
  return commandType === 'tasks.create' || commandType === 'tasks.complete';
}

function buildExecuteGateSnapshot(
  command: AICommandEnvelope<Record<string, unknown>>,
): {
  currentEntityVersions: Record<string, string>;
  invariantResults: Record<string, boolean>;
} {
  if (command.commandType !== 'tasks.complete') {
    return {
      currentEntityVersions: command.preconditions.requiredEntityVersions,
      invariantResults: Object.fromEntries(command.preconditions.invariants.map((invariant) => [invariant.check, true])),
    };
  }

  const taskId = taskIdFromPayload(command.payload);
  const task = typeof taskId === 'number' ? getTask(taskId) : null;
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
  const taskId = taskIdFromPayload(input.command.payload);
  if (typeof taskId !== 'number') {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now);
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

  try {
    await completeTask(input.userId, taskId);
    const readBack = getTask(taskId);
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
}

function taskCreatePayload(payload: Record<string, unknown>): Parameters<typeof createTask>[1] {
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
  };
}

function taskIdFromPayload(payload: Record<string, unknown>): number | null {
  const taskId = typeof payload.taskId === 'number'
    ? payload.taskId
    : Number(payload.taskId);
  return Number.isInteger(taskId) && taskId > 0 ? taskId : null;
}

function buildTaskCreateResultResponse(input: {
  capability: CapabilityDefinition;
  command: AICommandEnvelope<Record<string, unknown>>;
  title: string;
  taskId?: number;
  status: CommandStatus;
  locale?: string | null;
}): ChatCoreV2Response {
  const isPT = String(input.locale ?? '').toLowerCase().startsWith('pt');
  const isES = String(input.locale ?? '').toLowerCase().startsWith('es');
  const summary = isPT
    ? `Feito — criei a tarefa "${input.title}".`
    : isES
      ? `Listo — creé la tarea "${input.title}".`
      : `Done — I created the task "${input.title}".`;
  return buildChatCoreV2CommandResultResponse({
    capability: input.capability,
    commandId: input.command.commandId,
    title: isPT ? 'Tarefa criada' : isES ? 'Tarea creada' : 'Task created',
    summary,
    status: input.status,
    locale: input.locale,
    sourceEntityIds: typeof input.taskId === 'number' ? [`task:${input.taskId}`] : input.command.basedOn.entityIds,
    diff: [{ label: isPT ? 'Tarefa' : isES ? 'Tarea' : 'Task', after: input.title }],
  });
}

function buildTaskCompleteResultResponse(input: {
  capability: CapabilityDefinition;
  command: AICommandEnvelope<Record<string, unknown>>;
  title: string;
  taskId: number;
  status: CommandStatus;
  locale?: string | null;
}): ChatCoreV2Response {
  const isPT = String(input.locale ?? '').toLowerCase().startsWith('pt');
  const isES = String(input.locale ?? '').toLowerCase().startsWith('es');
  const summary = isPT
    ? `Feito — marquei "${input.title}" como concluída.`
    : isES
      ? `Listo — marqué "${input.title}" como completada.`
      : `Done — I marked "${input.title}" as done.`;
  const beforeStatus = isPT ? 'Pendente' : isES ? 'Pendiente' : 'Pending';
  const afterStatus = isPT ? 'Concluída' : isES ? 'Completada' : 'Done';
  return buildChatCoreV2CommandResultResponse({
    capability: input.capability,
    commandId: input.command.commandId,
    title: isPT ? 'Tarefa concluída' : isES ? 'Tarea completada' : 'Task completed',
    summary,
    status: input.status,
    locale: input.locale,
    sourceEntityIds: [`task:${input.taskId}`],
    diff: [
      { label: isPT ? 'Tarefa' : isES ? 'Tarea' : 'Task', after: input.title },
      { label: isPT ? 'Estado' : isES ? 'Estado' : 'Status', before: beforeStatus, after: afterStatus },
    ],
  });
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
