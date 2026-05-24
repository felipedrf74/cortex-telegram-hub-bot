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
const COMMAND_TTL_MS = 10 * 60 * 1000;

export function tryBuildChatCoreV2CommandPreviewRoute(
  input: BuildChatCoreV2CommandPreviewRouteInput,
): ChatCoreV2CommandPreviewRouteResult | null {
  const routeGuess = classifyShadowRoute(input.normalizedText);
  if (routeGuess.domains[0] !== 'tasks') return null;
  if (routeGuess.intent === 'create_action' && routeGuess.capabilityIds.includes(TASK_CREATE_CAPABILITY)) {
    return tryBuildTaskCreatePreview(input, routeGuess);
  }
  if (routeGuess.intent === 'modify_action' && routeGuess.capabilityIds.includes(TASK_COMPLETE_CAPABILITY)) {
    return tryBuildTaskCompletePreview(input, routeGuess);
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
    delegatedScopes: ['tasks:read', 'tasks:write'],
    permissionSnapshotVersion: command.authorization.permissionSnapshotVersion,
    currentEntityVersions: command.preconditions.requiredEntityVersions,
    invariantResults: Object.fromEntries(command.preconditions.invariants.map((invariant) => [invariant.check, true])),
    now: input.now,
  }, 'preview');
  if (!gateVerdict.ok) return null;

  const previewCapability = asPreviewOnlyCapability(input.capability);
  const response = buildChatCoreV2ActionPreviewResponse({
    capability: previewCapability,
    command,
    title: taskPreviewTitle(command.payload, input.input.locale),
    summary: taskPreviewSummary(command.payload, input.input.locale),
    diff: taskPreviewDiff(command.payload, input.input.locale),
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
