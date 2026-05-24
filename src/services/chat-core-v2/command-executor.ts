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
  createTask,
  getTask,
} from '../task-store/task-service';
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
  const gateVerdict = evaluateChatCoreV2CommandBusGate(input.command, {
    actorUserId: String(input.userId),
    tenantId: String(input.tenantId),
    delegatedScopes: input.command.authorization.delegatedScopes,
    permissionSnapshotVersion: input.command.authorization.permissionSnapshotVersion,
    currentEntityVersions: input.command.preconditions.requiredEntityVersions,
    decisionVersion: input.command.preconditions.requiredDecisionVersion,
    invariantResults: Object.fromEntries(input.command.preconditions.invariants.map((invariant) => [invariant.check, true])),
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
  if (!capability || input.command.commandType !== 'tasks.create') {
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
