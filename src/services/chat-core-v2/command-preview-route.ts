// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  getChatCoreV2Capability,
  isChatCoreV2CapabilityEnabled,
} from './capability-registry';
import {
  evaluateChatCoreV2CommandBusGate,
  type ChatCoreV2CommandGateVerdict,
} from './command-bus';
import {
  buildChatCoreV2ActionPreviewResponse,
  normalizeChatCoreV2Locale,
  type ChatCoreV2Response,
} from './response-contracts';
import {
  classifyShadowRoute,
  type ChatCoreV2ShadowRouteGuess,
} from './shadow-route-classifier';
import { hashStable } from './deterministic-read/common';
import {
  buildEntityResolutionPreconditions,
  resolveEntityReferenceFromCandidates,
} from './entity-resolution';
import { foldCalendarText } from '../calendar-natural-language-parser';
import { parseSimpleTaskStep } from '../chat/planner/simple-task';
import {
  listNotificationCenterItems,
  type NotificationCenterItem,
} from '../notification-orchestrator';
import { listTasks } from '../task-store/task-service';
import { computeContentHash } from '../task-store/unified-task-store';
import type { NormalizedTask } from '../task-store/types';
import type {
  AICommandEnvelope,
  CapabilityDefinition,
  CapabilitySupportMatrix,
  EntityReferenceResolution,
  EntityResolutionCandidate,
} from './types';

export const CHAT_CORE_V2_COMMAND_PREVIEW_ROUTE_VERSION = 'chat_core_v2_command_preview_route@1.0.0';

export interface BuildChatCoreV2CommandPreviewRouteInput {
  normalizedText: string;
  userId: number;
  tenantId: number;
  conversationId: string;
  messageId: string;
  locale?: string | null;
  timezone: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface ChatCoreV2CommandPreviewRouteResult {
  routeVersion: string;
  capabilityId: string;
  routeGuess: ChatCoreV2ShadowRouteGuess;
  command: AICommandEnvelope;
  gateVerdict: ChatCoreV2CommandGateVerdict;
  response: ChatCoreV2Response;
  executionEnabled: false;
  executionDisabledReason: 'preview_only_rollout';
}

const TASK_CREATE_CAPABILITY = 'tasks.create';
const TASK_COMPLETE_CAPABILITY = 'tasks.complete';
const NOTIFICATION_SNOOZE_CAPABILITY = 'notifications.snooze';
const COMMAND_TTL_MS = 10 * 60 * 1000;
const NOTIFICATION_SNOOZE_DEFAULT_MINUTES = 60;

export function tryBuildChatCoreV2CommandPreviewRoute(
  input: BuildChatCoreV2CommandPreviewRouteInput,
): ChatCoreV2CommandPreviewRouteResult | null {
  const routeGuess = classifyShadowRoute(input.normalizedText);
  if (routeGuess.domains[0] === 'tasks') {
    if (routeGuess.intent === 'create_action' && routeGuess.capabilityIds.includes(TASK_CREATE_CAPABILITY)) {
      return tryBuildTaskCreatePreview(input, routeGuess);
    }
    if (routeGuess.intent === 'modify_action' && routeGuess.capabilityIds.includes(TASK_COMPLETE_CAPABILITY)) {
      return tryBuildTaskCompletePreview(input, routeGuess);
    }
  }
  if (routeGuess.domains[0] === 'notifications') {
    if (routeGuess.intent === 'modify_action' && routeGuess.capabilityIds.includes(NOTIFICATION_SNOOZE_CAPABILITY)) {
      return tryBuildNotificationSnoozePreview(input, routeGuess);
    }
  }
  return null;
}

function tryBuildTaskCreatePreview(
  input: BuildChatCoreV2CommandPreviewRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2CommandPreviewRouteResult | null {
  const capability = getEnabledCapability(TASK_CREATE_CAPABILITY, input);
  if (!capability) return null;

  const now = input.now ?? new Date();
  const plannerInput = {
    text: input.normalizedText,
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    channel: 'ios' as const,
    locale: input.locale ?? undefined,
    timezone: input.timezone,
    nowIso: now.toISOString(),
    persistRuns: false,
    requireSafeWriteConfirmation: true,
  };
  const step = parseSimpleTaskStep(plannerInput, input.normalizedText);
  if (!step || step.action !== 'create_task' || step.risk !== 'safe_write' || !step.requiredArgsPresent) {
    return null;
  }

  const command = buildTaskCreateCommandEnvelope({
    input,
    now,
    args: step.args,
    idempotencyKey: step.idempotencyKey,
  });
  return buildCommandPreviewResult({
    input,
    routeGuess,
    capability,
    capabilityId: TASK_CREATE_CAPABILITY,
    command,
    now,
  });
}

function tryBuildTaskCompletePreview(
  input: BuildChatCoreV2CommandPreviewRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2CommandPreviewRouteResult | null {
  const capability = getEnabledCapability(TASK_COMPLETE_CAPABILITY, input);
  if (!capability) return null;

  const referencePhrase = extractTaskCompletionReference(input.normalizedText);
  if (!referencePhrase) return null;

  const pendingTasks = listTasks(input.userId, { status: 'pending' })
    .filter((task): task is NormalizedTask & { id: number } => Number.isFinite(task.id));
  const candidates = pendingTasks
    .map((task) => taskToResolutionCandidate(task, referencePhrase))
    .filter((candidate) => candidate.confidence > 0.45);
  const resolution = resolveEntityReferenceFromCandidates({
    entityType: 'task',
    userPhrase: referencePhrase,
    candidates,
  });
  if (resolution.status !== 'resolved' || !resolution.selectedCandidate) return null;

  const taskId = taskIdFromCandidate(resolution.selectedCandidate);
  const task = pendingTasks.find((candidateTask) => candidateTask.id === taskId);
  if (!task) return null;

  const now = input.now ?? new Date();
  const command = buildTaskCompleteCommandEnvelope({
    input,
    now,
    task,
    resolution,
  });
  return buildCommandPreviewResult({
    input,
    routeGuess,
    capability,
    capabilityId: TASK_COMPLETE_CAPABILITY,
    command,
    now,
  });
}

function tryBuildNotificationSnoozePreview(
  input: BuildChatCoreV2CommandPreviewRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2CommandPreviewRouteResult | null {
  const capability = getEnabledCapability(NOTIFICATION_SNOOZE_CAPABILITY, input);
  if (!capability) return null;

  const snoozeRequest = extractNotificationSnoozeRequest(input.normalizedText);
  const referencePhrase = snoozeRequest.referencePhrase;
  if (!referencePhrase) return null;

  const notifications = listNotificationCenterItems(input.userId, input.tenantId, {
    status: 'unread',
    limit: 50,
  });
  const candidates = notifications
    .map((item) => notificationToResolutionCandidate(item, referencePhrase))
    .filter((candidate) => candidate.confidence > 0.45);
  const resolution = resolveEntityReferenceFromCandidates({
    entityType: 'notification',
    userPhrase: referencePhrase,
    candidates,
  });
  if (resolution.status !== 'resolved' || !resolution.selectedCandidate) return null;

  const itemId = notificationIdFromCandidate(resolution.selectedCandidate);
  const item = notifications.find((candidateItem) => candidateItem.itemId === itemId);
  if (!item) return null;

  const now = input.now ?? new Date();
  const command = buildNotificationSnoozeCommandEnvelope({
    input,
    now,
    item,
    resolution,
    snoozeMinutes: snoozeRequest.snoozeMinutes,
  });
  return buildCommandPreviewResult({
    input,
    routeGuess,
    capability,
    capabilityId: NOTIFICATION_SNOOZE_CAPABILITY,
    command,
    now,
  });
}

function getEnabledCapability(
  capabilityId: string,
  input: BuildChatCoreV2CommandPreviewRouteInput,
): CapabilityDefinition | null {
  if (!isChatCoreV2CapabilityEnabled(capabilityId, {
    env: input.env ?? process.env,
    scope: { userId: input.userId, tenantId: input.tenantId },
  })) {
    return null;
  }

  return getChatCoreV2Capability(capabilityId) ?? null;
}

function buildCommandPreviewResult(input: {
  input: BuildChatCoreV2CommandPreviewRouteInput;
  routeGuess: ChatCoreV2ShadowRouteGuess;
  capability: CapabilityDefinition;
  capabilityId: string;
  command: AICommandEnvelope<Record<string, unknown>>;
  now: Date;
}): ChatCoreV2CommandPreviewRouteResult | null {
  const command = input.command;
  const gateVerdict = evaluateChatCoreV2CommandBusGate(command, {
    actorUserId: String(input.input.userId),
    tenantId: String(input.input.tenantId),
    delegatedScopes: command.authorization.delegatedScopes,
    permissionSnapshotVersion: command.authorization.permissionSnapshotVersion,
    currentEntityVersions: command.preconditions.requiredEntityVersions,
    invariantResults: Object.fromEntries(command.preconditions.invariants.map((invariant) => [invariant.check, true])),
    now: input.now,
  }, 'preview');
  if (!gateVerdict.ok) return null;

  const previewCapability = asPreviewOnlyCapability(input.capability);
  const previewCopy = buildPreviewCopy(input.capabilityId, command.payload, input.input.locale);
  const response = buildChatCoreV2ActionPreviewResponse({
    capability: previewCapability,
    command,
    title: previewCopy.title,
    summary: previewCopy.summary,
    diff: previewCopy.diff,
    locale: input.input.locale,
    expiresAt: command.expiresAt,
  });
  response.reasonCodes = [
    ...response.reasonCodes,
    'preview_only_rollout',
  ];

  return {
    routeVersion: CHAT_CORE_V2_COMMAND_PREVIEW_ROUTE_VERSION,
    capabilityId: input.capabilityId,
    routeGuess: input.routeGuess,
    command,
    gateVerdict,
    response,
    executionEnabled: false,
    executionDisabledReason: 'preview_only_rollout',
  };
}

function buildTaskCreateCommandEnvelope(input: {
  input: BuildChatCoreV2CommandPreviewRouteInput;
  now: Date;
  args: Record<string, unknown>;
  idempotencyKey: string;
}): AICommandEnvelope<Record<string, unknown>> {
  const title = String(input.args.title ?? '').trim();
  const dueDateTime = typeof input.args.dueDateTime === 'string' && input.args.dueDateTime.trim()
    ? input.args.dueDateTime.trim()
    : null;
  const commandId = `cmd_${hashStable({
    tenantId: input.input.tenantId,
    userId: input.input.userId,
    messageId: input.input.messageId,
    title,
    dueDateTime,
  })}`;
  const createdAt = input.now.toISOString();
  const payload = {
    operation: 'create',
    title,
    dueDateTime,
    list: input.args.list ?? null,
    notes: input.args.notes ?? null,
  };

  return {
    commandId,
    commandSchemaVersion: 'tasks.create@1.0.0',
    previewSchemaVersion: 'task_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: String(input.input.tenantId),
    userId: String(input.input.userId),
    domain: 'tasks',
    commandType: 'tasks.create',
    origin: 'chat',
    payload,
    basedOn: {
      entityIds: [`task_draft:${commandId}`],
      entityVersions: {},
      contextHash: hashStable({
        routeVersion: CHAT_CORE_V2_COMMAND_PREVIEW_ROUTE_VERSION,
        textHash: hashStable({ text: input.input.normalizedText }),
        payload,
      }),
      createdAt,
    },
    preconditions: {
      requiredEntityVersions: {},
      requiredPermissionsVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:tasks:v1`,
      invariants: [],
    },
    authorization: {
      actorUserId: String(input.input.userId),
      tenantId: String(input.input.tenantId),
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read', 'tasks:write'],
      permissionSnapshotVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:tasks:v1`,
      authTime: createdAt,
    },
    expiresAt: new Date(input.now.getTime() + COMMAND_TTL_MS).toISOString(),
    idempotencyKey: `chat-v2:${input.input.tenantId}:${input.input.userId}:${input.idempotencyKey}`,
  };
}

function buildTaskCompleteCommandEnvelope(input: {
  input: BuildChatCoreV2CommandPreviewRouteInput;
  now: Date;
  task: NormalizedTask & { id: number };
  resolution: EntityReferenceResolution;
}): AICommandEnvelope<Record<string, unknown>> {
  const entityPreconditions = buildEntityResolutionPreconditions(input.resolution);
  const entityId = `task:${input.task.id}`;
  const createdAt = input.now.toISOString();
  const payload = {
    operation: 'complete',
    taskId: input.task.id,
    title: input.task.title,
    currentStatus: input.task.status,
    targetStatus: 'completed',
    dueDateTime: input.task.dueIsDatetime ? input.task.dueDate ?? null : null,
    dueDate: input.task.dueIsDatetime ? null : input.task.dueDate ?? null,
  };
  const commandId = `cmd_${hashStable({
    tenantId: input.input.tenantId,
    userId: input.input.userId,
    messageId: input.input.messageId,
    taskId: input.task.id,
    entityVersions: entityPreconditions.requiredEntityVersions,
  })}`;

  return {
    commandId,
    commandSchemaVersion: 'tasks.complete@1.0.0',
    previewSchemaVersion: 'task_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: String(input.input.tenantId),
    userId: String(input.input.userId),
    domain: 'tasks',
    commandType: 'tasks.complete',
    origin: 'chat',
    payload,
    basedOn: {
      entityIds: [entityId],
      entityVersions: entityPreconditions.requiredEntityVersions,
      contextHash: hashStable({
        routeVersion: CHAT_CORE_V2_COMMAND_PREVIEW_ROUTE_VERSION,
        textHash: hashStable({ text: input.input.normalizedText }),
        payload,
        resolution: input.resolution.reasonCodes,
      }),
      createdAt,
    },
    preconditions: {
      requiredEntityVersions: entityPreconditions.requiredEntityVersions,
      requiredPermissionsVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:tasks:v1`,
      invariants: [{
        type: 'task_status',
        description: 'Task must still be pending when the preview is confirmed.',
        check: 'task_is_pending',
      }],
    },
    authorization: {
      actorUserId: String(input.input.userId),
      tenantId: String(input.input.tenantId),
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read', 'tasks:write'],
      permissionSnapshotVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:tasks:v1`,
      authTime: createdAt,
    },
    expiresAt: new Date(input.now.getTime() + COMMAND_TTL_MS).toISOString(),
    idempotencyKey: `chat-v2:${input.input.tenantId}:${input.input.userId}:tasks.complete:${input.task.id}:${commandId}`,
  };
}

function buildNotificationSnoozeCommandEnvelope(input: {
  input: BuildChatCoreV2CommandPreviewRouteInput;
  now: Date;
  item: NotificationCenterItem;
  resolution: EntityReferenceResolution;
  snoozeMinutes: number;
}): AICommandEnvelope<Record<string, unknown>> {
  const entityPreconditions = buildEntityResolutionPreconditions(input.resolution);
  const entityId = `notification:${input.item.itemId}`;
  const createdAt = input.now.toISOString();
  const snoozedUntil = new Date(input.now.getTime() + input.snoozeMinutes * 60 * 1000).toISOString();
  const payload = {
    operation: 'snooze',
    notificationId: input.item.itemId,
    title: input.item.title,
    currentStatus: input.item.status,
    targetStatus: 'snoozed',
    snoozeMinutes: input.snoozeMinutes,
    snoozedUntil,
    sourceSkill: input.item.sourceSkill,
    type: input.item.type,
    priority: input.item.priority,
  };
  const commandId = `cmd_${hashStable({
    tenantId: input.input.tenantId,
    userId: input.input.userId,
    messageId: input.input.messageId,
    notificationId: input.item.itemId,
    snoozedUntil,
    entityVersions: entityPreconditions.requiredEntityVersions,
  })}`;

  return {
    commandId,
    commandSchemaVersion: 'notifications.snooze@1.0.0',
    previewSchemaVersion: 'notification_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: String(input.input.tenantId),
    userId: String(input.input.userId),
    domain: 'notifications',
    commandType: 'notifications.snooze',
    origin: 'chat',
    payload,
    basedOn: {
      entityIds: [entityId],
      entityVersions: entityPreconditions.requiredEntityVersions,
      contextHash: hashStable({
        routeVersion: CHAT_CORE_V2_COMMAND_PREVIEW_ROUTE_VERSION,
        textHash: hashStable({ text: input.input.normalizedText }),
        payload,
        resolution: input.resolution.reasonCodes,
      }),
      createdAt,
    },
    preconditions: {
      requiredEntityVersions: entityPreconditions.requiredEntityVersions,
      requiredPermissionsVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:notifications:v1`,
      invariants: [{
        type: 'notification_status',
        description: 'Notification must still be unread when the preview is confirmed.',
        check: 'notification_is_unread',
      }],
    },
    authorization: {
      actorUserId: String(input.input.userId),
      tenantId: String(input.input.tenantId),
      actingSurface: 'ios_chat',
      delegatedScopes: ['notifications:read', 'notifications:write'],
      permissionSnapshotVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:notifications:v1`,
      authTime: createdAt,
    },
    expiresAt: new Date(input.now.getTime() + COMMAND_TTL_MS).toISOString(),
    idempotencyKey: `chat-v2:${input.input.tenantId}:${input.input.userId}:notifications.snooze:${input.item.itemId}:${commandId}`,
  };
}

function asPreviewOnlyCapability(capability: CapabilityDefinition): CapabilityDefinition {
  const support: CapabilitySupportMatrix = {
    ...capability.support,
    execute: 'preview_only',
  };
  return {
    ...capability,
    support,
    confirmationPolicy: 'always_confirm_v1',
  };
}

function buildPreviewCopy(
  capabilityId: string,
  payload: Record<string, unknown>,
  locale: string | null | undefined,
): { title: string; summary: string; diff: Array<{ label: string; before?: string; after: string }> } {
  if (capabilityId === NOTIFICATION_SNOOZE_CAPABILITY) {
    return {
      title: notificationPreviewTitle(payload, locale),
      summary: notificationPreviewSummary(payload, locale),
      diff: notificationPreviewDiff(payload, locale),
    };
  }
  return {
    title: taskPreviewTitle(payload, locale),
    summary: taskPreviewSummary(payload, locale),
    diff: taskPreviewDiff(payload, locale),
  };
}

function taskPreviewTitle(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const title = String(payload.title ?? '').trim();
  const operation = payload.operation === 'complete' ? 'complete' : 'create';
  const normalized = normalizeChatCoreV2Locale(locale);
  if (operation === 'complete') {
    if (normalized === 'pt-BR') return `Prévia de conclusão: ${title}`;
    if (normalized === 'pt-PT') return `Pré-visualização de conclusão: ${title}`;
    if (normalized === 'es') return `Vista previa de finalización: ${title}`;
    return `Completion preview: ${title}`;
  }
  if (normalized === 'pt-BR') return `Prévia da tarefa: ${title}`;
  if (normalized === 'pt-PT') return `Pré-visualização da tarefa: ${title}`;
  if (normalized === 'es') return `Vista previa de la tarea: ${title}`;
  return `Task preview: ${title}`;
}

function taskPreviewSummary(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const title = String(payload.title ?? '').trim();
  const operation = payload.operation === 'complete' ? 'complete' : 'create';
  const due = typeof payload.dueDateTime === 'string' && payload.dueDateTime.trim()
    ? payload.dueDateTime.trim()
    : null;
  const normalized = normalizeChatCoreV2Locale(locale);
  if (operation === 'complete') {
    if (normalized === 'pt-BR') return `Eu marcaria "${title}" como concluída.`;
    if (normalized === 'pt-PT') return `Eu marcaria "${title}" como concluída.`;
    if (normalized === 'es') return `Marcaría "${title}" como completada.`;
    return `I would mark "${title}" as done.`;
  }
  if (normalized === 'pt-BR') {
    return due
      ? `Eu prepararia a tarefa "${title}" para ${due}.`
      : `Eu prepararia a tarefa "${title}".`;
  }
  if (normalized === 'pt-PT') {
    return due
      ? `Eu prepararia a tarefa "${title}" para ${due}.`
      : `Eu prepararia a tarefa "${title}".`;
  }
  if (normalized === 'es') {
    return due
      ? `Prepararía la tarea "${title}" para ${due}.`
      : `Prepararía la tarea "${title}".`;
  }
  return due
    ? `I would prepare the task "${title}" for ${due}.`
    : `I would prepare the task "${title}".`;
}

function taskPreviewDiff(payload: Record<string, unknown>, locale: string | null | undefined): Array<{ label: string; after: string }> {
  const normalized = normalizeChatCoreV2Locale(locale);
  const operation = payload.operation === 'complete' ? 'complete' : 'create';
  const labels = normalized === 'pt-BR'
    ? { task: 'Tarefa', due: 'Quando', status: 'Estado', pending: 'Pendente', completed: 'Concluída' }
    : normalized === 'pt-PT'
      ? { task: 'Tarefa', due: 'Quando', status: 'Estado', pending: 'Pendente', completed: 'Concluída' }
      : normalized === 'es'
        ? { task: 'Tarea', due: 'Cuándo', status: 'Estado', pending: 'Pendiente', completed: 'Completada' }
        : { task: 'Task', due: 'When', status: 'Status', pending: 'Pending', completed: 'Done' };
  const title = String(payload.title ?? '').trim();
  const due = typeof payload.dueDateTime === 'string' && payload.dueDateTime.trim()
    ? payload.dueDateTime.trim()
    : null;
  if (operation === 'complete') {
    return [
      { label: labels.task, after: title },
      { label: labels.status, after: labels.completed },
    ];
  }
  return [
    { label: labels.task, after: title },
    ...(due ? [{ label: labels.due, after: due }] : []),
  ];
}

function notificationPreviewTitle(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const title = String(payload.title ?? '').trim();
  const normalized = normalizeChatCoreV2Locale(locale);
  if (normalized === 'pt-BR') return `Prévia de pausa: ${title}`;
  if (normalized === 'pt-PT') return `Pré-visualização de pausa: ${title}`;
  if (normalized === 'es') return `Vista previa de pausa: ${title}`;
  return `Snooze preview: ${title}`;
}

function notificationPreviewSummary(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const title = String(payload.title ?? '').trim();
  const minutes = Number(payload.snoozeMinutes);
  const normalized = normalizeChatCoreV2Locale(locale);
  const duration = formatSnoozeDuration(minutes, normalized);
  if (normalized === 'pt-BR') return `Eu pausaria "${title}" por ${duration}.`;
  if (normalized === 'pt-PT') return `Eu pausaria "${title}" durante ${duration}.`;
  if (normalized === 'es') return `Pausaría "${title}" durante ${duration}.`;
  return `I would snooze "${title}" for ${duration}.`;
}

function notificationPreviewDiff(payload: Record<string, unknown>, locale: string | null | undefined): Array<{ label: string; before?: string; after: string }> {
  const normalized = normalizeChatCoreV2Locale(locale);
  const labels = normalized === 'pt-BR'
    ? { notification: 'Notificação', status: 'Estado', until: 'Até', unread: 'Não lida', snoozed: 'Pausada' }
    : normalized === 'pt-PT'
      ? { notification: 'Notificação', status: 'Estado', until: 'Até', unread: 'Por ler', snoozed: 'Pausada' }
      : normalized === 'es'
        ? { notification: 'Notificación', status: 'Estado', until: 'Hasta', unread: 'Sin leer', snoozed: 'Pausada' }
        : { notification: 'Notification', status: 'Status', until: 'Until', unread: 'Unread', snoozed: 'Snoozed' };
  return [
    { label: labels.notification, after: String(payload.title ?? '').trim() },
    { label: labels.status, before: labels.unread, after: labels.snoozed },
    { label: labels.until, after: String(payload.snoozedUntil ?? '').trim() },
  ];
}

function formatSnoozeDuration(minutes: number, locale: ReturnType<typeof normalizeChatCoreV2Locale>): string {
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : NOTIFICATION_SNOOZE_DEFAULT_MINUTES;
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

function extractNotificationSnoozeRequest(text: string): { referencePhrase: string | null; snoozeMinutes: number } {
  const snoozeMinutes = extractSnoozeMinutes(text);
  const withoutDuration = text
    .replace(/\b(?:for|durante|por)\s+(?:an?\s+|\d+\s+)?(?:hours?|hrs?|minutes?|mins?|minutos?|horas?)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const patterns = [
    /\b(?:snooze|pause)\s+(?:the\s+|my\s+)?(.+?)\s+notification\b/i,
    /\b(?:snooze|pause)\s+(?:the\s+|my\s+)?(.+?)\s+(?:alert|reminder)\b/i,
    /\b(?:snooze|pause)\s+(?:the\s+|my\s+)?(?:notification|alert|reminder)\s+(?:about|for|called|named)?\s*(.+?)(?=$|[.!?])/i,
    /\b(?:adiar|pausar|suspender)\s+(?:a\s+|o\s+|essa\s+|este\s+)?(.+?)\s+notifica[cç][aã]o\b/i,
    /\b(?:adiar|pausar|suspender)\s+(?:a\s+|o\s+|essa\s+|este\s+)?(.+?)\s+(?:alerta|lembrete)\b/i,
    /\b(?:adiar|pausar|suspender)\s+(?:a\s+|o\s+|essa\s+|este\s+)?(?:notifica[cç][aã]o|alerta|lembrete)\s+(?:sobre|chamada?)?\s*(.+?)(?=$|[.!?])/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(withoutDuration);
    const reference = cleanupNotificationReference(match?.[1]);
    if (reference) return { referencePhrase: reference, snoozeMinutes };
  }
  return { referencePhrase: null, snoozeMinutes };
}

function extractSnoozeMinutes(text: string): number {
  const match = /\b(?:for|durante|por)\s+(an?|one|uma?|um|\d+)\s*(hours?|hrs?|minutes?|mins?|minutos?|horas?)\b/i.exec(text);
  if (!match) return NOTIFICATION_SNOOZE_DEFAULT_MINUTES;
  const rawAmount = String(match[1] ?? '').toLowerCase();
  const amount = /^(?:a|an|one|um|uma)$/.test(rawAmount) ? 1 : Number.parseInt(rawAmount, 10);
  if (!Number.isFinite(amount) || amount <= 0) return NOTIFICATION_SNOOZE_DEFAULT_MINUTES;
  const unit = String(match[2] ?? '').toLowerCase();
  return /hour|hr|hora/.test(unit) ? Math.min(amount * 60, 24 * 60) : Math.min(amount, 24 * 60);
}

function cleanupNotificationReference(value: unknown): string | null {
  const cleaned = String(value ?? '')
    .replace(/^["“]|["”]$/g, '')
    .replace(/\b(?:notification|alert|reminder|notifica[cç][aã]o|alerta|lembrete)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!cleaned || /^(?:this|that|it|essa|esta|isso|the|my|a|o|la)$/i.test(cleaned)) return null;
  return cleaned;
}

function notificationToResolutionCandidate(item: NotificationCenterItem, referencePhrase: string): EntityResolutionCandidate {
  const confidence = scoreNotificationCandidate(referencePhrase, item);
  return {
    id: `notification:${item.itemId}`,
    label: item.title,
    confidence,
    reason: confidence >= 0.95
      ? 'title_exact_match'
      : confidence >= 0.84
        ? 'title_or_body_match'
        : 'title_partial_match',
    entityVersion: hashStable({
      title: item.title,
      safeBody: item.safeBody || item.body,
      sourceSkill: item.sourceSkill,
      type: item.type,
      priority: item.priority,
      status: item.status,
      actions: item.actions.map((action) => ({ id: action.id, label: action.label, style: action.style ?? null })),
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
    }),
    domain: 'notifications',
    metadata: {
      notificationId: item.itemId,
      status: item.status,
      sourceSkill: item.sourceSkill,
    },
  };
}

function scoreNotificationCandidate(referencePhrase: string, item: NotificationCenterItem): number {
  const reference = normalizeNotificationResolutionText(referencePhrase);
  const title = normalizeNotificationResolutionText(item.title);
  const body = normalizeNotificationResolutionText(item.safeBody || item.body);
  if (!reference || !title) return 0;
  if (reference === title) return 0.97;
  if (title.includes(reference)) return 0.9;
  if (reference.includes(title)) return 0.88;
  if (body.includes(reference)) return 0.84;

  const referenceTokens = new Set(reference.split(' ').filter((token) => token.length > 1));
  const titleTokens = new Set(`${title} ${body}`.split(' ').filter((token) => token.length > 1));
  if (referenceTokens.size === 0 || titleTokens.size === 0) return 0;
  const overlap = [...referenceTokens].filter((token) => titleTokens.has(token)).length;
  if (overlap === 0) return 0;
  const ratio = overlap / Math.max(referenceTokens.size, titleTokens.size);
  return Math.min(0.86, 0.55 + ratio * 0.35);
}

function normalizeNotificationResolutionText(value: string): string {
  return foldCalendarText(value)
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function notificationIdFromCandidate(candidate: EntityResolutionCandidate): string | null {
  const fromMetadata = candidate.metadata?.notificationId;
  if (typeof fromMetadata === 'string' && fromMetadata.trim()) return fromMetadata;
  const match = /^notification:(.+)$/.exec(candidate.id);
  return match?.[1] ?? null;
}

function extractTaskCompletionReference(text: string): string | null {
  const patterns = [
    /\b(?:complete|finish)\s+(?:the\s+|my\s+)?(.+?)\s+(?:task|todo|to-do)\b/i,
    /\b(?:mark|set)\s+(?:the\s+|my\s+)?(.+?)\s+(?:task|todo|to-do)\s+(?:as\s+)?(?:done|complete[d]?)\b/i,
    /\b(?:tick|check)\s+off\s+(?:the\s+|my\s+)?(.+?)\s+(?:task|todo|to-do)\b/i,
    /\b(?:concluir|conclui|completar|terminar|finalizar)\s+(?:a\s+|essa\s+|esta\s+)?tarefa\s+(.+?)(?=$|[.!?])/i,
    /\b(?:marca|marcar)\s+(?:a\s+|essa\s+|esta\s+)?tarefa\s+(.+?)\s+(?:como\s+)?(?:feita|conclu[ií]da|pronta)\b/i,
    /\b(?:marca|marcar)\s+(.+?)\s+(?:como\s+)?(?:feita|conclu[ií]da|pronta)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const reference = cleanupTaskReference(match?.[1]);
    if (reference) return reference;
  }
  return null;
}

function cleanupTaskReference(value: unknown): string | null {
  const cleaned = String(value ?? '')
    .replace(/^["“]|["”]$/g, '')
    .replace(/\s+(?:as\s+)?(?:done|complete[d]?|feita|conclu[ií]da|pronta)$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!cleaned || /^(?:this|that|it|essa|esta|isso|the|my|a|o|la)$/i.test(cleaned)) return null;
  return cleaned;
}

function taskToResolutionCandidate(task: NormalizedTask & { id: number }, referencePhrase: string): EntityResolutionCandidate {
  const confidence = scoreTaskCandidate(referencePhrase, task.title);
  return {
    id: `task:${task.id}`,
    label: task.title,
    confidence,
    reason: confidence >= 0.95
      ? 'title_exact_match'
      : confidence >= 0.84
        ? 'title_token_match'
        : 'title_partial_match',
    entityVersion: computeContentHash(task),
    domain: 'tasks',
    metadata: {
      taskId: task.id,
      status: task.status,
      dueDate: task.dueDate ?? null,
    },
  };
}

function scoreTaskCandidate(referencePhrase: string, title: string): number {
  const reference = normalizeTaskResolutionText(referencePhrase);
  const normalizedTitle = normalizeTaskResolutionText(title);
  if (!reference || !normalizedTitle) return 0;
  if (reference === normalizedTitle) return 0.97;
  if (normalizedTitle.includes(reference)) return 0.9;
  if (reference.includes(normalizedTitle)) return 0.88;

  const referenceTokens = new Set(reference.split(' ').filter((token) => token.length > 1));
  const titleTokens = new Set(normalizedTitle.split(' ').filter((token) => token.length > 1));
  if (referenceTokens.size === 0 || titleTokens.size === 0) return 0;
  const overlap = [...referenceTokens].filter((token) => titleTokens.has(token)).length;
  if (overlap === 0) return 0;
  const ratio = overlap / Math.max(referenceTokens.size, titleTokens.size);
  return Math.min(0.86, 0.55 + ratio * 0.35);
}

function normalizeTaskResolutionText(value: string): string {
  return foldCalendarText(value)
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function taskIdFromCandidate(candidate: EntityResolutionCandidate): number | null {
  const fromMetadata = candidate.metadata?.taskId;
  if (typeof fromMetadata === 'number' && Number.isFinite(fromMetadata)) return fromMetadata;
  const match = /^task:(\d+)$/.exec(candidate.id);
  return match ? Number(match[1]) : null;
}
