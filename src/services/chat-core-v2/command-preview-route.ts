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
import { parseSimpleTaskStep } from '../chat/planner/simple-task';
import type {
  AICommandEnvelope,
  CapabilityDefinition,
  CapabilitySupportMatrix,
  ChatCoreV2Domain,
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
const COMMAND_TTL_MS = 10 * 60 * 1000;

export function tryBuildChatCoreV2CommandPreviewRoute(
  input: BuildChatCoreV2CommandPreviewRouteInput,
): ChatCoreV2CommandPreviewRouteResult | null {
  const routeGuess = classifyShadowRoute(input.normalizedText);
  if (routeGuess.intent !== 'create_action' || routeGuess.domains[0] !== 'tasks') return null;
  if (!routeGuess.capabilityIds.includes(TASK_CREATE_CAPABILITY)) return null;
  if (!isChatCoreV2CapabilityEnabled(TASK_CREATE_CAPABILITY, {
    env: input.env ?? process.env,
    scope: { userId: input.userId, tenantId: input.tenantId },
  })) {
    return null;
  }

  const capability = getChatCoreV2Capability(TASK_CREATE_CAPABILITY);
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
  const gateVerdict = evaluateChatCoreV2CommandBusGate(command, {
    actorUserId: String(input.userId),
    tenantId: String(input.tenantId),
    delegatedScopes: ['tasks:read', 'tasks:write'],
    permissionSnapshotVersion: command.authorization.permissionSnapshotVersion,
    now,
  }, 'preview');
  if (!gateVerdict.ok) return null;

  const previewCapability = asPreviewOnlyCapability(capability);
  const response = buildChatCoreV2ActionPreviewResponse({
    capability: previewCapability,
    command,
    title: taskPreviewTitle(command.payload, input.locale),
    summary: taskPreviewSummary(command.payload, input.locale),
    diff: taskPreviewDiff(command.payload, input.locale),
    locale: input.locale,
    expiresAt: command.expiresAt,
  });
  response.reasonCodes = [
    ...response.reasonCodes,
    'preview_only_rollout',
  ];

  return {
    routeVersion: CHAT_CORE_V2_COMMAND_PREVIEW_ROUTE_VERSION,
    capabilityId: TASK_CREATE_CAPABILITY,
    routeGuess,
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

function taskPreviewTitle(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const title = String(payload.title ?? '').trim();
  const normalized = normalizeChatCoreV2Locale(locale);
  if (normalized === 'pt-BR') return `Prévia da tarefa: ${title}`;
  if (normalized === 'pt-PT') return `Pré-visualização da tarefa: ${title}`;
  if (normalized === 'es') return `Vista previa de la tarea: ${title}`;
  return `Task preview: ${title}`;
}

function taskPreviewSummary(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const title = String(payload.title ?? '').trim();
  const due = typeof payload.dueDateTime === 'string' && payload.dueDateTime.trim()
    ? payload.dueDateTime.trim()
    : null;
  const normalized = normalizeChatCoreV2Locale(locale);
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
  const labels = normalized === 'pt-BR'
    ? { task: 'Tarefa', due: 'Quando' }
    : normalized === 'pt-PT'
      ? { task: 'Tarefa', due: 'Quando' }
      : normalized === 'es'
        ? { task: 'Tarea', due: 'Cuándo' }
        : { task: 'Task', due: 'When' };
  const title = String(payload.title ?? '').trim();
  const due = typeof payload.dueDateTime === 'string' && payload.dueDateTime.trim()
    ? payload.dueDateTime.trim()
    : null;
  return [
    { label: labels.task, after: title },
    ...(due ? [{ label: labels.due, after: due }] : []),
  ];
}
