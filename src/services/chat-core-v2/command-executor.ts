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
  normalizeChatCoreV2Locale,
  type ChatCoreV2Response,
  type ChatCoreV2Locale,
} from './response-contracts';
import {
  recordChatV2CommandEvent,
} from './command-events';
import { hashStable } from './deterministic-read/common';
import {
  completeTask,
  createTask,
  getTask,
} from '../task-store/task-service';
import { computeContentHash } from '../task-store/unified-task-store';
import {
  getNotificationCenterItem,
  snoozeNotificationCenterItem,
  type NotificationCenterItem,
} from '../notification-orchestrator';
import {
  dismissDecision,
  getDecisionItem,
  type DecisionApiItem,
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
  return commandType === 'tasks.create'
    || commandType === 'tasks.complete'
    || commandType === 'notifications.snooze'
    || commandType === 'decision_center.dismiss';
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
    return buildTaskCompleteExecuteGateSnapshot(command);
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
): {
  currentEntityVersions: Record<string, string>;
  invariantResults: Record<string, boolean>;
} {
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
    ? { [entityId]: notificationVersionForItem(item) }
    : {};
  return {
    currentEntityVersions,
    invariantResults: {
      notification_is_unread: Boolean(item && item.status === 'unread'),
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
  const decisionVersion = item ? decisionVersionForItem(item) : undefined;
  const currentEntityVersions = entityId && decisionVersion
    ? { [entityId]: decisionVersion }
    : {};
  return {
    currentEntityVersions,
    decisionVersion,
    invariantResults: {
      decision_is_active: Boolean(item && item.status === 'unread'),
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
  const taskId = taskIdFromPayload(input.command.payload);
  if (typeof taskId !== 'number') {
    recordCommandEvent(input.command, input.capabilityId, 'command_failed', 'failed', 'execution_failed', input.now);
    return emptyExecutionFailure(input);
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

function notificationVersionForItem(item: NotificationCenterItem): string {
  return hashStable({
    title: item.title,
    safeBody: item.safeBody || item.body,
    sourceSkill: item.sourceSkill,
    type: item.type,
    priority: item.priority,
    status: item.status,
    actions: item.actions.map((action) => ({
      id: action.id,
      label: action.label,
      style: action.style ?? null,
    })),
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  });
}

function decisionVersionForItem(item: DecisionApiItem): string {
  return hashStable({
    decisionId: item.decisionId,
    title: item.title,
    summary: item.summary,
    safePreviewTitle: item.safePreviewTitle,
    safePreviewBody: item.safePreviewBody,
    status: item.status,
    urgency: item.urgency,
    sourceSkill: item.sourceSkill,
    type: item.type,
    actions: item.actions.map((action) => ({ id: action.id, label: action.label, style: action.style ?? null })),
    updatedAt: item.updatedAt,
    expiresAt: item.expiresAt,
    snoozedUntil: item.snoozedUntil,
  });
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
