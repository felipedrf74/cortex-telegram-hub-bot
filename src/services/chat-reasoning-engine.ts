// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';
import { getDb } from './database';
import { getTaskProviderForUser } from './task-store/task-router';
import { resolveTaskCreationList } from './task-store/task-list-resolution';
import { logger } from '../utils/logger';

export type ChatReasoningMode =
  | 'deterministic_fastpath'
  | 'simple_label'
  | 'structured_action'
  | 'multi_step_plan'
  | 'clarification'
  | 'high_risk_preview'
  | 'conversation_answer';

export type ChatActionSkill =
  | 'secretary'
  | 'training'
  | 'content'
  | 'cooking'
  | 'finance'
  | 'notifications'
  | 'chat'
  | 'system';

export type ChatActionIntent =
  | 'create_task'
  | 'create_task_with_subtasks'
  | 'add_subtasks_to_task'
  | 'create_multiple_tasks'
  | 'create_reminder'
  | 'schedule_event'
  | 'create_plan'
  | 'submit_feedback'
  | 'reschedule_session'
  | 'create_idea'
  | 'create_brief'
  | 'create_script'
  | 'schedule_content_work'
  | 'create_meal_plan'
  | 'create_shopping_list'
  | 'substitute_ingredient'
  | 'create_expense'
  | 'create_payment_reminder'
  | 'mark_paid'
  | 'create_notification_intent'
  | 'resolve_notification_action';

export type ChatRiskLevel = 'low' | 'medium' | 'high';

export type ChatActionFrame = {
  version: 'chat_action_frame.v1';
  primaryIntent: ChatActionIntent;
  skill: ChatActionSkill;
  entities: Record<string, unknown>;
  steps: Array<{ action: ChatActionIntent; entities: Record<string, unknown> }>;
  confidence: number;
  ambiguityFlags: string[];
  missingFields: string[];
  riskLevel: ChatRiskLevel;
  requiresConfirmation: boolean;
  userFacingSummary: string;
  reasoningMode: ChatReasoningMode;
};

export type CreateTaskWithSubtasksEntities = {
  title: string;
  subtasks: string[];
  dueAt: string | null;
  reminderAt: string | null;
  notes: string | null;
  priority: string | null;
  list: string | null;
  language: 'en' | 'pt' | 'es' | 'mixed' | 'unknown';
  extractionConfidence: number;
};

export type ChatReasoningContextPack = {
  userId: number;
  tenantId: number;
  locale?: string;
  timezone?: string;
  allowedActions: ChatActionIntent[];
};

export type ChatReasoningDecision =
  | { decision: 'allow'; reason: string }
  | { decision: 'needs_clarification'; reason: string; missingFields?: string[] }
  | { decision: 'needs_confirmation'; reason: string }
  | { decision: 'deny'; reason: string };

export type ChatActionExecutionResult = {
  status: 'completed' | 'partial_failure' | 'failed' | 'needs_clarification' | 'needs_confirmation' | 'deferred' | 'in_progress';
  response: {
    id: string;
    text: string;
    domain: 'secretary';
    routeMethod: 'chat-reasoning-engine' | 'confirmation-required';
    confidence: number;
    buttons: null;
    metadata: Record<string, unknown>;
    timestamp: string;
  };
};

type TaskProviderLike = {
  getLists?: () => Promise<any>;
  findListByName?: (name: string) => Promise<any>;
  getDefaultList?: () => Promise<any>;
  getTask?: (listId: string, taskId: string, listName?: string) => Promise<any>;
  searchTasks?: (query: string) => Promise<any>;
  createTask?: (listId: string, listName: string, data: any) => Promise<any>;
  getChecklistItems?: (listId: string, taskId: string) => Promise<any>;
  addChecklistItem?: (listId: string, taskId: string, displayName: string) => Promise<any>;
};

type TryHandleInput = {
  text: string;
  userId: number;
  tenantId: number;
  sourceMessageId: string;
  clientRequestId?: string | null;
  correlationId?: string | null;
  locale?: string;
  timezone?: string;
};

type ExecuteOptions = TryHandleInput & {
  frame: ChatActionFrame;
  provider?: TaskProviderLike;
  persistPlan?: boolean;
};

type ActionManifest = {
  skill: ChatActionSkill;
  action: ChatActionIntent;
  riskLevel: ChatRiskLevel;
  requiresConfirmation: boolean;
  implemented: boolean;
  undoSupported: boolean;
  requiredFields: string[];
};

type ActionPlanClaim = {
  actionPlanId: string;
  acquired: boolean;
  status: string;
};

export const CHAT_ACTION_MANIFESTS: ActionManifest[] = [
  { skill: 'secretary', action: 'create_task', riskLevel: 'low', requiresConfirmation: false, implemented: true, undoSupported: false, requiredFields: ['title'] },
  { skill: 'secretary', action: 'create_task_with_subtasks', riskLevel: 'low', requiresConfirmation: false, implemented: true, undoSupported: false, requiredFields: ['title', 'subtasks'] },
  { skill: 'secretary', action: 'add_subtasks_to_task', riskLevel: 'low', requiresConfirmation: false, implemented: true, undoSupported: false, requiredFields: ['title', 'subtasks'] },
  { skill: 'secretary', action: 'create_reminder', riskLevel: 'medium', requiresConfirmation: false, implemented: false, undoSupported: false, requiredFields: ['title', 'reminderAt'] },
  { skill: 'secretary', action: 'schedule_event', riskLevel: 'medium', requiresConfirmation: false, implemented: false, undoSupported: false, requiredFields: ['title', 'startAt'] },
  { skill: 'training', action: 'create_plan', riskLevel: 'medium', requiresConfirmation: true, implemented: false, undoSupported: false, requiredFields: ['goal'] },
  { skill: 'training', action: 'submit_feedback', riskLevel: 'low', requiresConfirmation: false, implemented: false, undoSupported: false, requiredFields: ['feedback'] },
  { skill: 'training', action: 'reschedule_session', riskLevel: 'medium', requiresConfirmation: true, implemented: false, undoSupported: false, requiredFields: ['sessionId', 'targetDate'] },
  { skill: 'content', action: 'create_idea', riskLevel: 'low', requiresConfirmation: false, implemented: false, undoSupported: false, requiredFields: ['topic'] },
  { skill: 'content', action: 'create_brief', riskLevel: 'low', requiresConfirmation: false, implemented: false, undoSupported: false, requiredFields: ['topic'] },
  { skill: 'content', action: 'create_script', riskLevel: 'medium', requiresConfirmation: false, implemented: false, undoSupported: false, requiredFields: ['briefId'] },
  { skill: 'content', action: 'schedule_content_work', riskLevel: 'medium', requiresConfirmation: false, implemented: false, undoSupported: false, requiredFields: ['title', 'scheduledAt'] },
  { skill: 'cooking', action: 'create_meal_plan', riskLevel: 'medium', requiresConfirmation: false, implemented: false, undoSupported: false, requiredFields: ['range'] },
  { skill: 'cooking', action: 'create_shopping_list', riskLevel: 'low', requiresConfirmation: false, implemented: false, undoSupported: false, requiredFields: ['items'] },
  { skill: 'cooking', action: 'substitute_ingredient', riskLevel: 'medium', requiresConfirmation: true, implemented: false, undoSupported: false, requiredFields: ['ingredient'] },
  { skill: 'finance', action: 'create_expense', riskLevel: 'medium', requiresConfirmation: false, implemented: false, undoSupported: false, requiredFields: ['amount'] },
  { skill: 'finance', action: 'create_payment_reminder', riskLevel: 'medium', requiresConfirmation: false, implemented: false, undoSupported: false, requiredFields: ['title', 'dueAt'] },
  { skill: 'finance', action: 'mark_paid', riskLevel: 'high', requiresConfirmation: true, implemented: false, undoSupported: false, requiredFields: ['entityId'] },
  { skill: 'notifications', action: 'create_notification_intent', riskLevel: 'medium', requiresConfirmation: false, implemented: false, undoSupported: false, requiredFields: ['type'] },
  { skill: 'notifications', action: 'resolve_notification_action', riskLevel: 'medium', requiresConfirmation: false, implemented: false, undoSupported: false, requiredFields: ['notificationId', 'action'] },
];

const MAX_TASK_TITLE_LENGTH = 500;
const MAX_SUBTASK_TITLE_LENGTH = 200;
const MAX_SUBTASKS = 25;

const READ_INTENT_PATTERNS = [
  /\b(show|list|what'?s|what is|open)\s+(my\s+)?(tasks|todo|to[- ]?dos|agenda|calendar|week|day)\b/i,
  /\b(mostra|listar|abre|quais sao|quais são)\s+(as\s+minhas\s+)?(tarefas|agenda|calendario|calendário|semana)\b/i,
];

assertUniqueManifests(CHAT_ACTION_MANIFESTS);

const TASK_CREATE_PATTERNS = /\b(create|add|make|cria|criar|crie|adiciona|adicionar|crear|crea|agrega|agregar|añade|anade|añadir|anadir)\b.*\b(tasks?|todo|to-do|tarefas?|tareas?|checklist)\b/i;
const SUBTASK_MARKER_PATTERNS = /\b(sub\s*tasks?|subtasks?|subtarefas?|subtareas?|checklist(?:\s+items?)?|steps?|itens?|elementos?)\b/i;
const ADD_SUBTASK_PATTERNS = /\b(add|adiciona|adicionar|añade|anade|añadir|anadir|agrega|agregar)\b.*\b(to|under|à|a|na|no|en|bajo)\b.*\b(task|tarefa|tarea)?\b/i;
const DESTRUCTIVE_VERBS = /\b(delete|remove|cancel|clear|apaga|apagar|remove|remover|cancela|cancelar|borra|borrar|elimina|eliminar)\b/i;
const DESTRUCTIVE_SWEEP_TARGETS = /\b(all|everything|todos|todas|tudo|todo|toda)\b/i;
const DESTRUCTIVE_OBJECT_TARGETS = /\b(tasks?|todo|to-do|agenda|calendar|events?|meetings?|tarefas?|calend[aá]rio|eventos?|reuni(?:a|ã)o|reuniões|tareas?|calendario|reuniones?)\b/i;
const MULTI_STEP_SECOND_ACTION = /\b(and|e|y)\s+(?:remind|schedule|reschedule|cancel|delete|move|plan|mark|create|add|lembrar|agenda|agendar|remarcar|cancela|cancelar|apaga|apagar|mover|marcar|cria|criar|crear|programar|recordar|eliminar|borrar|añade|anade)\b/i;

const DISCOURSE_TAILS = [
  /\bfor now(?:\s+that'?s\s+it)?\.?$/i,
  /\bthat'?s\s+(?:it|all)\.?$/i,
  /\band\s+that'?s\s+all\.?$/i,
  /\bjust\s+this\.?$/i,
  /\bnothing\s+else\.?$/i,
  /\bpor\s+agora(?:\s+e\s+so\s+isso)?\.?$/i,
  /\bé\s+só\s+isso\.?$/i,
  /\be\s+so\s+isso\.?$/i,
];

export function buildChatReasoningContextPack(input: {
  userId: number;
  tenantId?: number;
  locale?: string;
  timezone?: string;
}): ChatReasoningContextPack {
  if (!Number.isInteger(input.tenantId) || input.tenantId! <= 0) {
    throw new Error('chat_reasoning_missing_authenticated_tenant');
  }
  return {
    userId: input.userId,
    tenantId: input.tenantId!,
    locale: input.locale,
    timezone: input.timezone,
    allowedActions: CHAT_ACTION_MANIFESTS
      .filter((manifest) => manifest.implemented || manifest.skill !== 'secretary')
      .map((manifest) => manifest.action),
  };
}

export function detectChatReasoningMode(text: string): ChatReasoningMode {
  const trimmed = text.trim();
  if (!trimmed) return 'conversation_answer';
  if (/^(who am i|whoami|quem sou eu)\??$/i.test(trimmed)) return 'deterministic_fastpath';
  if (READ_INTENT_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'deterministic_fastpath';
  if (isDestructiveIntent(trimmed)) return 'high_risk_preview';
  if (/^(fix that|undo that|no,?\s+i meant|corrige isso|desfaz isso)/i.test(trimmed)) return 'clarification';
  if (hasMultiStepActionIntent(trimmed)) return 'multi_step_plan';
  if (TASK_CREATE_PATTERNS.test(trimmed) || ADD_SUBTASK_PATTERNS.test(trimmed)) return 'structured_action';
  if (/\b(plan|schedule|reschedule|training|session|calendar|meal plan|grocery|invoice|marathon|recording|plano|agenda|jantar|fatura)\b/i.test(trimmed)) {
    return 'multi_step_plan';
  }
  return 'conversation_answer';
}

export function parseDeterministicActionFrame(text: string): ChatActionFrame | null {
  const mode = detectChatReasoningMode(text);
  if (mode !== 'structured_action') return null;

  const cleaned = stripDiscourseTail(text.trim());
  const quoted = extractQuotedSegments(cleaned);

  const addFrame = parseAddSubtasksFrame(cleaned, quoted);
  if (addFrame) return addFrame;

  const checklistFrame = parseChecklistFrame(cleaned);
  if (checklistFrame) return checklistFrame;

  const createWithSubtasks = parseCreateTaskWithSubtasksFrame(cleaned, quoted);
  if (createWithSubtasks) return createWithSubtasks;

  const implicitSubtasks = parseImplicitTaskWithSubtasksFrame(cleaned);
  if (implicitSubtasks) return implicitSubtasks;

  const multipleTasks = parseCreateMultipleTasksFrame(cleaned, quoted);
  if (multipleTasks) return multipleTasks;

  const oneTask = parseCreateTaskFrame(cleaned, quoted);
  if (oneTask) return oneTask;

  return null;
}

export function validateChatActionFrame(
  frame: ChatActionFrame,
  context: ChatReasoningContextPack,
): ChatReasoningDecision {
  const manifest = CHAT_ACTION_MANIFESTS.find((candidate) => (
    candidate.skill === frame.skill && candidate.action === frame.primaryIntent
  ));
  if (!manifest) return { decision: 'deny', reason: 'unsupported_action' };
  if (!context.allowedActions.includes(frame.primaryIntent)) {
    return { decision: 'deny', reason: 'action_not_allowed_for_context' };
  }
  if (!manifest.implemented) {
    return { decision: 'deny', reason: 'manifest_only_action_not_executable' };
  }
  if ((frame.entities as any).userId != null || (frame.entities as any).tenantId != null || (frame.entities as any).ownerId != null) {
    return { decision: 'deny', reason: 'model_identity_fields_rejected' };
  }
  if (containsAuthoritativeIdentityField(frame.entities) || frame.steps.some((step) => containsAuthoritativeIdentityField(step.entities))) {
    return { decision: 'deny', reason: 'model_identity_fields_rejected' };
  }
  if (frame.missingFields.length > 0) {
    return { decision: 'needs_clarification', reason: 'missing_required_fields', missingFields: frame.missingFields };
  }
  if (frame.confidence < 0.72) {
    return { decision: 'needs_clarification', reason: 'low_confidence_action_frame' };
  }
  if (manifest.requiresConfirmation || frame.requiresConfirmation || frame.riskLevel === 'high') {
    return { decision: 'needs_confirmation', reason: 'action_requires_confirmation' };
  }

  if (frame.primaryIntent === 'create_task') {
    const title = normalizeTitle((frame.entities as any).title);
    if (!title) return { decision: 'needs_clarification', reason: 'missing_title', missingFields: ['title'] };
  }

  if (frame.primaryIntent === 'create_task_with_subtasks' || frame.primaryIntent === 'add_subtasks_to_task') {
    const entities = frame.entities as Partial<CreateTaskWithSubtasksEntities>;
    const title = normalizeTitle(entities.title);
    const subtasks = normalizeSubtasks(entities.subtasks);
    if (!title) return { decision: 'needs_clarification', reason: 'missing_title', missingFields: ['title'] };
    if (subtasks.length === 0) return { decision: 'needs_clarification', reason: 'missing_subtasks', missingFields: ['subtasks'] };
    if (subtasks.length > MAX_SUBTASKS) return { decision: 'needs_clarification', reason: 'too_many_subtasks', missingFields: ['subtasks'] };
  }

  if (frame.primaryIntent === 'create_multiple_tasks') {
    return { decision: 'needs_clarification', reason: 'bulk_task_creation_not_executable_in_v1' };
  }

  return { decision: 'allow', reason: 'validated' };
}

export async function tryHandleChatReasoningAction(input: TryHandleInput): Promise<ChatActionExecutionResult | null> {
  const mode = detectChatReasoningMode(input.text);
  if (mode !== 'structured_action' && mode !== 'high_risk_preview' && mode !== 'clarification' && mode !== 'multi_step_plan') return null;

  if (mode === 'high_risk_preview') {
    const response = buildNonExecutableResponse({
      input,
      status: 'needs_confirmation',
      text: 'Before I make a destructive change, I need explicit confirmation with a preview. I did not delete, cancel, or clear anything.',
      metadata: {
        type: 'chat_action_confirmation_required',
        reasoningMode: mode,
        reason: 'destructive_action',
        involvedSkills: ['secretary', 'training'],
      },
    });
    response.response.routeMethod = 'confirmation-required';
    return response;
  }

  if (mode === 'multi_step_plan') {
    if (!hasMultiStepActionIntent(input.text)) return null;
    return buildNonExecutableResponse({
      input,
      status: 'needs_clarification',
      text: 'I see more than one action in that message. I did not change anything yet. Please confirm the steps one at a time or ask me to preview the full plan first.',
      metadata: { type: 'chat_action_clarification_required', reasoningMode: mode, reason: 'multi_step_action_requires_preview' },
    });
  }

  const frame = parseDeterministicActionFrame(input.text);
  if (!frame) return null;

  return executeChatReasoningFrame({
    ...input,
    frame,
    persistPlan: true,
  });
}

export async function executeChatReasoningFrame(options: ExecuteOptions): Promise<ChatActionExecutionResult> {
  const context = buildChatReasoningContextPack(options);
  const validation = validateChatActionFrame(options.frame, context);
  if (validation.decision !== 'allow') {
    return buildValidationResponse(options, validation);
  }

  if (options.frame.primaryIntent === 'create_task_with_subtasks') {
    return executeCreateTaskWithSubtasks(options);
  }

  if (options.frame.primaryIntent === 'create_task') {
    return executeCreateTask(options);
  }

  if (options.frame.primaryIntent === 'add_subtasks_to_task') {
    return executeAddSubtasksToTask(options);
  }

  return buildNonExecutableResponse({
    input: options,
    status: 'deferred',
    text: 'I understood the action, but I cannot safely complete that request yet. I did not change anything.',
    metadata: {
      type: 'chat_action_deferred',
      actionFrame: sanitizeFrameForResponse(options.frame),
      reason: 'unsupported_v1_execution',
    },
  });
}

async function executeCreateTaskWithSubtasks(options: ExecuteOptions): Promise<ChatActionExecutionResult> {
  const entities = normalizeCreateTaskWithSubtasksEntities(options.frame.entities);
  const provider = options.provider || getTaskProviderForUser(options.userId);
  if (typeof provider.createTask !== 'function' || typeof provider.addChecklistItem !== 'function') {
    return buildNonExecutableResponse({
      input: options,
      status: 'failed',
      text: 'I understood the task and subtasks, but the active task provider cannot create checklist items.',
      metadata: {
        type: 'chat_action_execution_failed',
        actionFrame: sanitizeFrameForResponse(options.frame),
        reason: 'task_provider_missing_checklist_support',
      },
    });
  }

  const existingPlan = options.persistPlan !== false ? findReusablePlan(options) : null;
  if (existingPlan) {
    const resumed = await replayOrResumeTaskWithSubtasks(options, provider, existingPlan, entities);
    if (resumed) return resumed;
  }

  const actionPlanClaim = options.persistPlan !== false
    ? claimActionPlan(options, 'executing')
    : { actionPlanId: `plan-${randomUUID()}`, acquired: true, status: 'executing' };
  if (!actionPlanClaim.acquired) {
    const claimedPlan = findReusablePlan(options);
    if (claimedPlan) {
      const resumed = await replayOrResumeTaskWithSubtasks(options, provider, claimedPlan, entities);
      if (resumed) return resumed;
    }
    return buildInProgressReplayResponse(options, actionPlanClaim.actionPlanId, {
      reason: 'action_plan_already_claimed',
      existingStatus: actionPlanClaim.status,
    });
  }

  const actionPlanId = actionPlanClaim.actionPlanId;
  const list = await resolveTaskCreationList(provider, entities.list);
  if (!list?.id) {
    updateActionPlanStatus(actionPlanId, options, 'failed', []);
    return buildNonExecutableResponse({
      input: options,
      status: 'failed',
      text: 'I could not find a task list to create this in. I did not create anything.',
      metadata: {
        type: 'chat_action_execution_failed',
        actionPlanId,
        actionFrame: sanitizeFrameForResponse(options.frame),
        reason: 'missing_task_list',
      },
    });
  }

  const taskResult = await provider.createTask(String(list.id), list.displayName || list.name || 'Tasks', {
    title: entities.title,
    body: entities.notes || undefined,
    importance: entities.priority || undefined,
    dueDateTime: entities.dueAt || undefined,
  });

  if (!taskResult?.success || !taskResult.data?.id) {
    updateActionPlanStatus(actionPlanId, options, 'failed', []);
    return buildNonExecutableResponse({
      input: options,
      status: 'failed',
      text: 'I understood the task, but task creation failed before any subtasks were added.',
      metadata: {
        type: 'chat_action_execution_failed',
        actionPlanId,
        actionFrame: sanitizeFrameForResponse(options.frame),
        reason: 'task_create_failed',
      },
    });
  }

  const createdTask = taskResult.data;
  const taskRef = {
    entityType: 'task',
    entityId: String(createdTask.id),
    listId: String(createdTask.listId || list.id),
    title: entities.title,
  };
  updateActionPlanStatus(actionPlanId, options, 'executing', [taskRef]);
  const createdItems: Array<{ id: string; displayName: string; isChecked: boolean }> = [];
  const failedSubtasks: string[] = [];

  for (const subtask of entities.subtasks) {
    try {
      const added = await provider.addChecklistItem!(String(createdTask.listId || list.id), String(createdTask.id), subtask);
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
    String(createdTask.listId || list.id),
    String(createdTask.id),
    entities.title,
    entities.subtasks.filter((subtask) => !failedSubtasks.includes(subtask)),
  );
  const status = failedSubtasks.length === 0 && verification.ok ? 'completed' : 'partial_failure';
  const refs = [
    taskRef,
    ...createdItems.map((item) => ({
      entityType: 'subtask',
      entityId: item.id,
      parentTaskId: String(createdTask.id),
      title: item.displayName,
    })),
  ];
  updateActionPlanStatus(actionPlanId, options, status, refs);

  return buildTaskCreatedResponse({
    input: options,
    actionPlanId,
    task: verification.task || createdTask,
    checklistItems: verification.checklistItems.length > 0 ? verification.checklistItems : createdItems,
    failedSubtasks,
    warnings: verification.warnings,
    verificationStatus: status === 'completed' ? 'verified' : 'partial_failure',
  });
}

async function executeCreateTask(options: ExecuteOptions): Promise<ChatActionExecutionResult> {
  const title = normalizeTitle((options.frame.entities as any).title);
  const provider = options.provider || getTaskProviderForUser(options.userId);
  if (!title) {
    return buildValidationResponse(options, { decision: 'needs_clarification', reason: 'missing_title', missingFields: ['title'] });
  }
  if (typeof provider.createTask !== 'function') {
    return buildNonExecutableResponse({
      input: options,
      status: 'failed',
      text: 'I understood the task, but the active task provider cannot create tasks right now.',
      metadata: {
        type: 'chat_action_execution_failed',
        actionFrame: sanitizeFrameForResponse(options.frame),
        reason: 'task_provider_missing_create_support',
      },
    });
  }

  const existingPlan = options.persistPlan !== false ? findReusablePlan(options) : null;
  if (existingPlan) {
    const refs = safeJsonParse(existingPlan.created_entity_refs_json, []);
    const taskRef = Array.isArray(refs) ? refs.find((ref: any) => ref?.entityType === 'task') : null;
    if (taskRef?.listId && taskRef?.entityId) {
      const verified = await verifyTaskWithSubtasks(provider, String(taskRef.listId), String(taskRef.entityId), title, []);
      const verificationStatus = verified.task && verified.ok ? 'verified' : 'partial_failure';
      updateActionPlanStatus(existingPlan.action_plan_id, options, verificationStatus === 'verified' ? 'completed' : 'partial_failure', refs);
      return buildPlainTaskCreatedResponse({
        input: options,
        actionPlanId: existingPlan.action_plan_id,
        task: verified.task || taskRef,
        warnings: [
          'Duplicate request detected; returned the existing task instead of creating another one.',
          ...verified.warnings,
        ],
        verificationStatus,
        idempotentReplay: true,
      });
    }
    if (existingPlan.status === 'executing') {
      return buildInProgressReplayResponse(options, existingPlan.action_plan_id);
    }
  }

  const actionPlanClaim = options.persistPlan !== false
    ? claimActionPlan(options, 'executing')
    : { actionPlanId: `plan-${randomUUID()}`, acquired: true, status: 'executing' };
  if (!actionPlanClaim.acquired) {
    return buildInProgressReplayResponse(options, actionPlanClaim.actionPlanId, {
      reason: 'action_plan_already_claimed',
      existingStatus: actionPlanClaim.status,
    });
  }

  const actionPlanId = actionPlanClaim.actionPlanId;
  const list = await resolveTaskCreationList(provider, (options.frame.entities as any).list);
  if (!list?.id) {
    updateActionPlanStatus(actionPlanId, options, 'failed', []);
    return buildNonExecutableResponse({
      input: options,
      status: 'failed',
      text: 'I could not find a task list to create this in. I did not create anything.',
      metadata: { type: 'chat_action_execution_failed', actionPlanId, actionFrame: sanitizeFrameForResponse(options.frame), reason: 'missing_task_list' },
    });
  }

  const taskResult = await provider.createTask(String(list.id), list.displayName || list.name || 'Tasks', {
    title,
  });
  if (!taskResult?.success || !taskResult.data?.id) {
    updateActionPlanStatus(actionPlanId, options, 'failed', []);
    return buildNonExecutableResponse({
      input: options,
      status: 'failed',
      text: 'I understood the task, but task creation failed.',
      metadata: { type: 'chat_action_execution_failed', actionPlanId, actionFrame: sanitizeFrameForResponse(options.frame), reason: 'task_create_failed' },
    });
  }

  const createdTask = taskResult.data;
  const refs = [{
    entityType: 'task',
    entityId: String(createdTask.id),
    listId: String(createdTask.listId || list.id),
    title,
  }];
  updateActionPlanStatus(actionPlanId, options, 'executing', refs);
  const verification = await verifyTaskWithSubtasks(
    provider,
    String(createdTask.listId || list.id),
    String(createdTask.id),
    title,
    [],
  );
  const verificationStatus = verification.task && verification.ok ? 'verified' : 'partial_failure';
  updateActionPlanStatus(actionPlanId, options, verificationStatus === 'verified' ? 'completed' : 'partial_failure', refs);

  return buildPlainTaskCreatedResponse({
    input: options,
    actionPlanId,
    task: verification.task || createdTask,
    warnings: verification.warnings,
    verificationStatus,
  });
}

async function replayOrResumeTaskWithSubtasks(
  options: ExecuteOptions,
  provider: TaskProviderLike,
  existingPlan: any,
  entities: CreateTaskWithSubtasksEntities,
): Promise<ChatActionExecutionResult | null> {
  const refs = safeJsonParse(existingPlan.created_entity_refs_json, []);
  const taskRef = Array.isArray(refs) ? refs.find((ref: any) => ref?.entityType === 'task') : null;
  if (!taskRef?.listId || !taskRef?.entityId) {
    if (existingPlan.status === 'executing') {
      return buildInProgressReplayResponse(options, existingPlan.action_plan_id);
    }
    return null;
  }

  let verified = await verifyTaskWithSubtasks(provider, String(taskRef.listId), String(taskRef.entityId), entities.title, entities.subtasks);
  let addedItems: Array<{ id: string; displayName: string; isChecked: boolean }> = [];
  let failedSubtasks: string[] = [];
  const missingSubtasks = verified.verificationBlind ? [] : verified.missingSubtasks;

  if (verified.verificationBlind) {
    return buildInProgressReplayResponse(options, existingPlan.action_plan_id, {
      reason: 'verification_blind',
      warnings: verified.warnings,
    });
  }

  if (missingSubtasks.length > 0 && typeof provider.addChecklistItem === 'function') {
    for (const subtask of missingSubtasks) {
      try {
        const added = await provider.addChecklistItem(String(taskRef.listId), String(taskRef.entityId), subtask);
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
    verified = await verifyTaskWithSubtasks(provider, String(taskRef.listId), String(taskRef.entityId), entities.title, entities.subtasks);
  }

  const mergedRefs = mergeEntityRefs(refs, addedItems.map((item) => ({
    entityType: 'subtask',
    entityId: item.id,
    parentTaskId: String(taskRef.entityId),
    title: item.displayName,
  })));
  const status = failedSubtasks.length === 0 && verified.ok ? 'completed' : 'partial_failure';
  updateActionPlanStatus(existingPlan.action_plan_id, options, status, mergedRefs);

  return buildTaskCreatedResponse({
    input: options,
    actionPlanId: existingPlan.action_plan_id,
    task: verified.task || taskRef,
    checklistItems: verified.checklistItems.length > 0 ? verified.checklistItems : addedItems,
    failedSubtasks,
    warnings: [
      existingPlan.status === 'executing'
        ? 'Recovered an in-progress request and reused the existing task instead of creating another one.'
        : 'Duplicate request detected; returned the existing task instead of creating another one.',
      ...verified.warnings,
    ],
    verificationStatus: status === 'completed' ? 'verified' : 'partial_failure',
    idempotentReplay: true,
  });
}

async function executeAddSubtasksToTask(options: ExecuteOptions): Promise<ChatActionExecutionResult> {
  const entities = normalizeCreateTaskWithSubtasksEntities(options.frame.entities);
  const provider = options.provider || getTaskProviderForUser(options.userId);
  if (typeof provider.searchTasks !== 'function' || typeof provider.addChecklistItem !== 'function') {
    return buildNonExecutableResponse({
      input: options,
      status: 'failed',
      text: 'I understood the requested subtasks, but the active task provider cannot safely find and update an existing task.',
      metadata: { type: 'chat_action_execution_failed', actionFrame: sanitizeFrameForResponse(options.frame), reason: 'task_provider_missing_search_or_checklist' },
    });
  }

  const matchesResult = await provider.searchTasks(entities.title);
  const matches = extractArray(matchesResult?.data || matchesResult)
    .filter((task: any) => normalizeComparable(task?.title) === normalizeComparable(entities.title));
  if (matches.length !== 1) {
    return buildNonExecutableResponse({
      input: options,
      status: 'needs_clarification',
      text: matches.length > 1
        ? `I found more than one task called “${entities.title}”. Which one should I update?`
        : `I could not find an existing “${entities.title}” task. Should I create it with those subtasks?`,
      metadata: {
        type: 'chat_action_clarification_required',
        actionFrame: sanitizeFrameForResponse(options.frame),
        reason: matches.length > 1 ? 'multiple_task_matches' : 'no_task_match',
        matchCount: matches.length,
      },
    });
  }

  const task = matches[0];
  const actionPlanClaim = options.persistPlan !== false
    ? claimActionPlan(options, 'executing')
    : { actionPlanId: `plan-${randomUUID()}`, acquired: true, status: 'executing' };
  if (!actionPlanClaim.acquired) {
    return buildInProgressReplayResponse(options, actionPlanClaim.actionPlanId, {
      reason: 'action_plan_already_claimed',
      existingStatus: actionPlanClaim.status,
    });
  }

  const actionPlanId = actionPlanClaim.actionPlanId;
  const addedItems: Array<{ id: string; displayName: string; isChecked: boolean }> = [];
  const failedSubtasks: string[] = [];
  for (const subtask of entities.subtasks) {
    try {
      const added = await provider.addChecklistItem!(String(task.listId), String(task.id), subtask);
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
    String(task.listId),
    String(task.id),
    entities.title,
    entities.subtasks.filter((subtask) => !failedSubtasks.includes(subtask)),
  );
  const status = failedSubtasks.length === 0 && verification.ok ? 'completed' : 'partial_failure';
  updateActionPlanStatus(actionPlanId, options, status, [
    { entityType: 'task', entityId: String(task.id), listId: String(task.listId), title: entities.title },
    ...addedItems.map((item) => ({ entityType: 'subtask', entityId: item.id, parentTaskId: String(task.id), title: item.displayName })),
  ]);

  return buildTaskCreatedResponse({
    input: options,
    actionPlanId,
    task: verification.task || task,
    checklistItems: verification.checklistItems.length > 0 ? verification.checklistItems : addedItems,
    failedSubtasks,
    warnings: verification.warnings,
    verificationStatus: status === 'completed' ? 'verified' : 'partial_failure',
    responseType: 'task_subtasks_added',
  });
}

async function verifyTaskWithSubtasks(
  provider: TaskProviderLike,
  listId: string,
  taskId: string,
  expectedTitle: string,
  expectedSubtasks: string[],
): Promise<{
  ok: boolean;
  task: any | null;
  checklistItems: Array<{ id: string; displayName: string; isChecked: boolean }>;
  missingSubtasks: string[];
  warnings: string[];
  verificationBlind: boolean;
}> {
  const warnings: string[] = [];
  let task: any | null = null;
  if (typeof provider.getTask === 'function') {
    const taskResult = await provider.getTask(listId, taskId);
    if (taskResult?.success && taskResult.data) task = taskResult.data;
  }
  if (!task) warnings.push('task_read_back_unavailable');
  let checklistItems = Array.isArray(task?.checklistItems) ? task.checklistItems : [];
  let checklistReadSucceeded = Array.isArray(task?.checklistItems);
  if (checklistItems.length === 0 && typeof provider.getChecklistItems === 'function') {
    try {
      const checklistResult = await provider.getChecklistItems(listId, taskId);
      if (checklistResult?.success && Array.isArray(checklistResult.data)) {
        checklistItems = checklistResult.data;
        checklistReadSucceeded = true;
      }
    } catch {
      // Treat checklist read failures as unknown state; retry code must not re-add blindly.
    }
  }
  const verificationBlind = expectedSubtasks.length > 0 && !task && !checklistReadSucceeded;
  if (verificationBlind) warnings.push('checklist_read_back_unavailable');

  if (task && normalizeComparable(task.title) !== normalizeComparable(expectedTitle)) {
    warnings.push('created_task_title_mismatch');
  }
  const actualSubtasks = checklistItems.map((item: any) => normalizeComparable(item.displayName || item.title));
  const missing = verificationBlind
    ? []
    : expectedSubtasks.filter((subtask) => !actualSubtasks.includes(normalizeComparable(subtask)));
  if (missing.length > 0) warnings.push('created_subtasks_missing');
  return {
    ok: warnings.length === 0,
    task,
    checklistItems: checklistItems.map((item: any) => ({
      id: String(item.id),
      displayName: String(item.displayName || item.title || ''),
      isChecked: !!item.isChecked,
    })),
    missingSubtasks: missing,
    warnings,
    verificationBlind,
  };
}

function buildTaskCreatedResponse(input: {
  input: ExecuteOptions;
  actionPlanId: string;
  task: any;
  checklistItems: Array<{ id: string; displayName: string; isChecked: boolean }>;
  failedSubtasks: string[];
  warnings: string[];
  verificationStatus: 'verified' | 'partial_failure';
  idempotentReplay?: boolean;
  responseType?: 'task_created' | 'task_subtasks_added';
}): ChatActionExecutionResult {
  const timestamp = new Date().toISOString();
  const taskTitle = String(input.task?.title || (input.input.frame.entities as any).title || 'Task');
  const successfulSubtasks = input.checklistItems.map((item) => item.displayName).filter(Boolean);
  const bulletLines = successfulSubtasks.map((subtask) => `• ${subtask}`).join('\n');
  const failedLine = input.failedSubtasks.length > 0
    ? `\n\nI could not add: ${input.failedSubtasks.join(', ')}.`
    : '';
  const text = input.responseType === 'task_subtasks_added'
    ? `✅ Added ${successfulSubtasks.length} subtasks to “${taskTitle}”:\n${bulletLines}${failedLine}`
    : `✅ Created task “${taskTitle}” with ${successfulSubtasks.length} subtasks:\n${bulletLines}${failedLine}`;

  return {
    status: input.verificationStatus === 'verified' ? 'completed' : 'partial_failure',
    response: {
      id: `msg-${Date.now()}`,
      text,
      domain: 'secretary',
      routeMethod: 'chat-reasoning-engine',
      confidence: input.input.frame.confidence,
      buttons: null,
      metadata: {
        type: input.responseType || 'task_created',
        reasoningEngineVersion: 'v1',
        reasoningMode: input.input.frame.reasoningMode,
        actionPlanId: input.actionPlanId,
        actionFrame: sanitizeFrameForResponse(input.input.frame),
        taskId: String(input.task?.id || ''),
        listId: String(input.task?.listId || ''),
        title: taskTitle,
        subtasks: input.checklistItems.map((item) => ({
          id: item.id,
          title: item.displayName,
          isChecked: item.isChecked,
        })),
        failedSubtasks: input.failedSubtasks,
        warnings: input.warnings,
        verificationStatus: input.verificationStatus,
        actions: ['view_task', 'add_more'],
        idempotentReplay: !!input.idempotentReplay,
      },
      timestamp,
    },
  };
}

function buildPlainTaskCreatedResponse(input: {
  input: ExecuteOptions;
  actionPlanId: string;
  task: any;
  warnings: string[];
  verificationStatus: 'verified' | 'partial_failure';
  idempotentReplay?: boolean;
}): ChatActionExecutionResult {
  const timestamp = new Date().toISOString();
  const taskTitle = String(input.task?.title || input.task?.entityId || (input.input.frame.entities as any).title || 'Task');

  return {
    status: input.verificationStatus === 'verified' ? 'completed' : 'partial_failure',
    response: {
      id: `msg-${Date.now()}`,
      text: `✅ Created task “${taskTitle}”.`,
      domain: 'secretary',
      routeMethod: 'chat-reasoning-engine',
      confidence: input.input.frame.confidence,
      buttons: null,
      metadata: {
        type: 'task_created',
        reasoningEngineVersion: 'v1',
        reasoningMode: input.input.frame.reasoningMode,
        actionPlanId: input.actionPlanId,
        actionFrame: sanitizeFrameForResponse(input.input.frame),
        taskId: String(input.task?.id || input.task?.entityId || ''),
        listId: String(input.task?.listId || ''),
        title: taskTitle,
        subtasks: [],
        failedSubtasks: [],
        warnings: input.warnings,
        verificationStatus: input.verificationStatus,
        actions: ['view_task', 'add_more'],
        idempotentReplay: !!input.idempotentReplay,
      },
      timestamp,
    },
  };
}

function buildInProgressReplayResponse(
  input: ExecuteOptions,
  actionPlanId: string,
  extraMetadata: Record<string, unknown> = {},
): ChatActionExecutionResult {
  return buildNonExecutableResponse({
    input,
    status: 'in_progress',
    text: 'That request is already in progress. I did not create a duplicate task; please refresh in a moment.',
    metadata: {
      type: 'chat_action_in_progress',
      actionPlanId,
      actionFrame: sanitizeFrameForResponse(input.frame),
      idempotentReplay: true,
      ...extraMetadata,
    },
  });
}

function buildValidationResponse(options: ExecuteOptions, validation: ChatReasoningDecision): ChatActionExecutionResult {
  const status = validation.decision === 'needs_confirmation'
    ? 'needs_confirmation'
    : validation.decision === 'needs_clarification'
      ? 'needs_clarification'
      : 'failed';
  return buildNonExecutableResponse({
    input: options,
    status,
    text: validation.decision === 'needs_confirmation'
      ? 'I understood the action, but I need confirmation before executing it.'
      : validation.decision === 'needs_clarification'
        ? 'I need one clarification before I can safely do that.'
        : 'I could not safely execute that request.',
    metadata: {
      type: validation.decision === 'needs_confirmation'
        ? 'chat_action_confirmation_required'
        : validation.decision === 'needs_clarification'
          ? 'chat_action_clarification_required'
          : 'chat_action_denied',
      actionFrame: sanitizeFrameForResponse(options.frame),
      reason: validation.reason,
      ...(validation.decision === 'needs_clarification' ? { missingFields: validation.missingFields || [] } : {}),
    },
  });
}

function buildNonExecutableResponse(input: {
  input: Pick<TryHandleInput, 'text' | 'sourceMessageId'> & Partial<ExecuteOptions>;
  status: ChatActionExecutionResult['status'];
  text: string;
  metadata: Record<string, unknown>;
}): ChatActionExecutionResult {
  return {
    status: input.status,
    response: {
      id: `msg-${Date.now()}`,
      text: input.text,
      domain: 'secretary',
      routeMethod: 'chat-reasoning-engine',
      confidence: input.input.frame?.confidence ?? 1,
      buttons: null,
      metadata: {
        reasoningEngineVersion: 'v1',
        ...input.metadata,
      },
      timestamp: new Date().toISOString(),
    },
  };
}

function parseCreateTaskWithSubtasksFrame(cleaned: string, quoted: string[]): ChatActionFrame | null {
  if (!SUBTASK_MARKER_PATTERNS.test(removeQuotedSegments(cleaned))) return null;
  const marker = /(.*?)\b(?:where\s+it\s+has|with|including|that\s+has|com|incluindo|con)?\s*(?:sub\s*tasks?|subtasks?|subtarefas?|subtareas?|checklist(?:\s+items?)?|steps?|itens?|elementos?)\s*(?:called|named|chamadas?|chamados?|llamadas?|llamados?)?\s+(.+)$/i;
  const match = cleaned.match(marker);
  if (!match) return null;

  const titlePart = match[1] || '';
  const itemsPart = match[2] || '';
  const title = extractTaskTitle(titlePart, quoted);
  const subtasks = splitSubtaskItems(itemsPart);
  if (!title || subtasks.length === 0) return null;

  return buildSecretaryFrame('create_task_with_subtasks', title, subtasks, detectLanguage(cleaned), 0.94);
}

function parseChecklistFrame(cleaned: string): ChatActionFrame | null {
  const match = cleaned.match(/^\s*(?:create|make|cria|criar|crie|crear|crea)\s+(?:a\s+|uma?\s+|una?\s+)?checklist\s+(?:called|named|chamado|chamada|llamado|llamada)?\s*(.+?)\s*:\s*(.+)$/i);
  if (!match) return null;
  const title = normalizeTitle(match[1]);
  const subtasks = splitSubtaskItems(match[2]);
  if (!title || subtasks.length === 0) return null;
  return buildSecretaryFrame('create_task_with_subtasks', title, subtasks, detectLanguage(cleaned), 0.9);
}

function parseImplicitTaskWithSubtasksFrame(cleaned: string): ChatActionFrame | null {
  const match = cleaned.match(/^\s*(?:cria|criar|crie|crear|crea)\s+(?:uma?\s+|una?\s+)?(?:tarefa|tarea)\s+(?:chamada?|chamado|llamada?|llamado)?\s*(.+?)\s+(?:com|con)\s+(.+)$/i);
  if (!match) return null;
  const title = normalizeTitle(match[1]);
  const subtasks = splitSubtaskItems(match[2]);
  if (!title || subtasks.length < 2) return null;
  return buildSecretaryFrame('create_task_with_subtasks', title, subtasks, detectLanguage(cleaned), 0.86);
}

function parseAddSubtasksFrame(cleaned: string, quoted: string[]): ChatActionFrame | null {
  const textWithoutQuotes = removeQuotedSegments(cleaned);
  if (!/^\s*(add|adiciona|adicionar|añade|anade|añadir|anadir|agrega|agregar)\b/i.test(textWithoutQuotes)) return null;
  if (hasMultiRecipientAddIntent(textWithoutQuotes)) {
    return {
      ...buildSecretaryFrame('add_subtasks_to_task', 'multiple tasks', [], detectLanguage(cleaned), 0.55),
      missingFields: ['targetTask'],
      ambiguityFlags: ['multi_recipient_subtask_update'],
      userFacingSummary: 'Clarify which subtasks belong to which task',
    };
  }
  const match = cleaned.match(/^\s*(?:add|adiciona|adicionar|añade|anade|añadir|anadir|agrega|agregar)\s+(.+?)\s+(?:to|under|à|a|na|no|en|bajo)\s+(?:my\s+|minha\s+|meu\s+|mi\s+)?(?:task\s+|tarefa\s+|tarea\s+)?(.+?)(?:\s+task|\s+tarefa|\s+tarea)?$/i);
  if (!match) return null;
  const subtasks = splitSubtaskItems(match[1]);
  const title = normalizeTitle(stripArticleAndTaskWords(match[2], quoted));
  if (!title || subtasks.length === 0) return null;
  return buildSecretaryFrame('add_subtasks_to_task', title, subtasks, detectLanguage(cleaned), 0.88);
}

function parseCreateMultipleTasksFrame(cleaned: string, quoted: string[]): ChatActionFrame | null {
  const match = cleaned.match(/^\s*(?:create|cria|criar|crie|crear|crea)\s+(?:(\d+|three|two|multiple|varias|várias|duas|tres|três|dos)\s+)?(?:tasks|tarefas|tareas)\b[:\s]*(.+)$/i);
  if (!match) {
    return null;
  }
  const listPart = match[2] || '';
  if (!match[1] && !/(?:,|;|\n|\u2022|•|\band\b|\be\b|\by\b)/i.test(listPart)) return null;
  const tasks = splitSubtaskItems(listPart);
  if (tasks.length < 2) return null;
  return {
    ...buildSecretaryFrame('create_task_with_subtasks', tasks[0], tasks.slice(1), detectLanguage(cleaned), 0.8),
    primaryIntent: 'create_multiple_tasks',
    steps: tasks.map((title) => ({ action: 'create_task', entities: { title } })),
    userFacingSummary: `Create ${tasks.length} separate tasks`,
    ambiguityFlags: quoted.length > 0 ? [] : ['bulk_task_intent'],
  };
}

function parseCreateTaskFrame(cleaned: string, quoted: string[]): ChatActionFrame | null {
  if (!TASK_CREATE_PATTERNS.test(cleaned)) return null;
  const title = extractTaskTitle(cleaned, quoted);
  if (!title) return null;
  return {
    ...buildSecretaryFrame('create_task', title, [], detectLanguage(cleaned), 0.84),
    entities: {
      title,
      dueAt: null,
      reminderAt: null,
      notes: null,
      priority: null,
      list: null,
      language: detectLanguage(cleaned),
      extractionConfidence: 0.84,
    },
    steps: [{ action: 'create_task', entities: { title } }],
    userFacingSummary: `Create task “${title}”`,
  };
}

function buildSecretaryFrame(
  intent: 'create_task_with_subtasks' | 'add_subtasks_to_task',
  title: string,
  subtasks: string[],
  language: CreateTaskWithSubtasksEntities['language'],
  confidence: number,
): ChatActionFrame;
function buildSecretaryFrame(
  intent: 'create_task',
  title: string,
  subtasks: string[],
  language: CreateTaskWithSubtasksEntities['language'],
  confidence: number,
): ChatActionFrame;
function buildSecretaryFrame(
  intent: 'create_task' | 'create_task_with_subtasks' | 'add_subtasks_to_task',
  title: string,
  subtasks: string[],
  language: CreateTaskWithSubtasksEntities['language'],
  confidence: number,
): ChatActionFrame {
  const entities: CreateTaskWithSubtasksEntities = {
    title,
    subtasks,
    dueAt: null,
    reminderAt: null,
    notes: null,
    priority: null,
    list: null,
    language,
    extractionConfidence: confidence,
  };
  return {
    version: 'chat_action_frame.v1',
    primaryIntent: intent,
    skill: 'secretary',
    entities,
    steps: [{ action: intent, entities }],
    confidence,
    ambiguityFlags: [],
    missingFields: title && (intent === 'create_task' || subtasks.length > 0) ? [] : ['title', 'subtasks'],
    riskLevel: 'low',
    requiresConfirmation: false,
    userFacingSummary: intent === 'add_subtasks_to_task'
      ? `Add ${subtasks.length} subtasks to “${title}”`
      : `Create task “${title}” with ${subtasks.length} subtasks`,
    reasoningMode: 'structured_action',
  };
}

function extractTaskTitle(prefix: string, quoted: string[]): string {
  const withoutQuoted = removeQuotedSegments(prefix);
  const hasQuotedTitle = quoted.length > 0 && /\b(called|named|chamada?|chamado?|llamada?|llamado?)\s+__QUOTE_0__/i.test(replaceQuotedSegments(prefix));
  if (hasQuotedTitle) return normalizeTitle(quoted[0]);

  let title = prefix
    .replace(/^\s*(please\s+)?(create|add|make|cria|criar|crie|adiciona|adicionar|crear|crea|agrega|agregar|añade|anade|añadir|anadir)\s+/i, '')
    .replace(/^\s*(a|one|uma|um|una|un)\s+/i, '')
    .replace(/^\s*(tasks?|todo|to-do|tarefas?|tareas?|checklist)\s+/i, '')
    .replace(/^\s*(called|named|chamada?|chamado?|llamada?|llamado?)\s+/i, '')
    .replace(/\s+(where\s+it\s+has|with|including|that\s+has|com|incluindo|con)\s*$/i, '')
    .trim();
  if (quoted.length > 0 && replaceQuotedSegments(title).trim() === '__QUOTE_0__') return normalizeTitle(quoted[0]);
  const quotedOnly = title.match(/^["“”'‘’]([^"“”'‘’]+)["“”'‘’]$/);
  if (quotedOnly?.[1]) return normalizeTitle(quotedOnly[1]);
  if (!title && quoted.length > 0 && withoutQuoted.includes('__QUOTE_0__')) title = quoted[0];
  return normalizeTitle(title.replace(/__QUOTE_\d+__/g, '').trim());
}

function stripArticleAndTaskWords(value: string, quoted: string[]): string {
  const withPlaceholders = replaceQuotedSegments(value);
  const replaced = withPlaceholders.replace(/__QUOTE_(\d+)__/g, (_all, index) => quoted[Number(index)] || '');
  return replaced
    .replace(/^\s*(the|a|uma|um|una|un|minha|meu|my|mi)\s+/i, '')
    .replace(/\s*(task|tarefa|tarea)\s*$/i, '')
    .trim();
}

function splitSubtaskItems(value: string): string[] {
  const stripped = stripDiscourseEverywhere(stripDiscourseTail(value))
    .replace(/^\s*(called|named|chamadas?|chamados?|llamadas?|llamados?)\s+/i, '')
    .trim();
  const quoted = extractQuotedSegments(stripped);
  if (quoted.length > 0) return normalizeSubtasks(quoted);

  const commaSplit = stripped
    .split(/\s*(?:,|;|\n|\u2022|•)\s*|\s+(?:and|e|y)\s+/g)
    .map(normalizeTitle)
    .filter(Boolean);
  if (commaSplit.length > 1) return normalizeSubtasks(commaSplit);

  const words = stripped.split(/\s+/).map(normalizeTitle).filter(Boolean);
  if (words.length >= 2 && words.every((word) => /^[\p{L}\p{N}][\p{L}\p{N}+.-]*$/u.test(word))) {
    return normalizeSubtasks(words);
  }
  return normalizeSubtasks([stripped]);
}

function normalizeCreateTaskWithSubtasksEntities(raw: Record<string, unknown>): CreateTaskWithSubtasksEntities {
  return {
    title: normalizeTitle(raw.title),
    subtasks: normalizeSubtasks(raw.subtasks),
    dueAt: typeof raw.dueAt === 'string' && raw.dueAt.trim() ? raw.dueAt.trim() : null,
    reminderAt: typeof raw.reminderAt === 'string' && raw.reminderAt.trim() ? raw.reminderAt.trim() : null,
    notes: typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim() : null,
    priority: typeof raw.priority === 'string' && raw.priority.trim() ? raw.priority.trim() : null,
    list: typeof raw.list === 'string' && raw.list.trim() ? raw.list.trim() : null,
    language: raw.language === 'en' || raw.language === 'pt' || raw.language === 'es' || raw.language === 'mixed' ? raw.language : 'unknown',
    extractionConfidence: typeof raw.extractionConfidence === 'number' ? raw.extractionConfidence : 0,
  };
}

function sanitizeFrameForResponse(frame: ChatActionFrame): ChatActionFrame {
  return {
    ...frame,
    entities: stripAuthoritativeIdentityFields(frame.entities) as Record<string, unknown>,
    steps: frame.steps.map((step) => ({
      ...step,
      entities: stripAuthoritativeIdentityFields(step.entities) as Record<string, unknown>,
    })),
  };
}

function claimActionPlan(options: ExecuteOptions, status: string): ActionPlanClaim {
  const db = getDb();
  const actionPlanId = `cap_${randomUUID()}`;
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO chat_action_plans (
      action_plan_id,
      tenant_id,
      user_id,
      source_message_id,
      client_request_id,
      status,
      frame_json,
      steps_json,
      correlation_id,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 days'))
  `).run(
    actionPlanId,
    options.tenantId,
    options.userId,
    options.sourceMessageId,
    options.clientRequestId || null,
    status,
    JSON.stringify(sanitizeFrameForResponse(options.frame)),
    JSON.stringify(options.frame.steps),
    options.correlationId || null,
  );
  if (inserted.changes === 1) {
    return { actionPlanId, acquired: true, status };
  }

  const existing = db.prepare(`
    SELECT action_plan_id, status
    FROM chat_action_plans
    WHERE tenant_id = ? AND user_id = ? AND source_message_id = ?
  `).get(options.tenantId, options.userId, options.sourceMessageId) as { action_plan_id: string; status: string } | undefined;

  if (!existing) {
    throw new Error('chat_action_plan_claim_failed');
  }

  return {
    actionPlanId: existing.action_plan_id,
    acquired: false,
    status: existing.status,
  };
}

function findReusablePlan(options: ExecuteOptions): any | null {
  try {
    return getDb().prepare(`
      SELECT *
      FROM chat_action_plans
      WHERE tenant_id = ? AND user_id = ? AND source_message_id = ?
        AND status IN ('executing', 'completed', 'partial_failure')
    `).get(options.tenantId, options.userId, options.sourceMessageId) || null;
  } catch (err) {
    logger.debug({ err, userId: options.userId, tenantId: options.tenantId }, 'chat action plan lookup skipped');
    return null;
  }
}

function updateActionPlanStatus(
  actionPlanId: string,
  options: ExecuteOptions,
  status: string,
  refs: unknown[],
): void {
  if (options.persistPlan === false) return;
  try {
    getDb().prepare(`
      UPDATE chat_action_plans
      SET status = ?, created_entity_refs_json = ?, updated_at = datetime('now')
      WHERE action_plan_id = ? AND tenant_id = ? AND user_id = ?
    `).run(status, JSON.stringify(refs), actionPlanId, options.tenantId, options.userId);
  } catch (err) {
    logger.warn({ err, userId: options.userId, tenantId: options.tenantId, status }, 'chat action plan status update failed');
  }
}

function stripDiscourseTail(value: string): string {
  let output = value.trim();
  for (const pattern of DISCOURSE_TAILS) {
    output = output.replace(pattern, '').trim();
  }
  return output.replace(/[.。]+$/g, '').trim();
}

function stripDiscourseEverywhere(value: string): string {
  return value
    .replace(/\bfor now(?:\s+that'?s\s+it)?\b/gi, ' ')
    .replace(/\bthat'?s\s+(?:it|all)\b/gi, ' ')
    .replace(/\band\s+that'?s\s+all\b/gi, ' ')
    .replace(/\bjust\s+this\b/gi, ' ')
    .replace(/\bnothing\s+else\b/gi, ' ')
    .replace(/\bpor\s+agora(?:\s+e\s+so\s+isso)?\b/gi, ' ')
    .replace(/\bé\s+só\s+isso\b/gi, ' ')
    .replace(/\be\s+so\s+isso\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDestructiveIntent(value: string): boolean {
  if (!DESTRUCTIVE_VERBS.test(value)) return false;
  return DESTRUCTIVE_SWEEP_TARGETS.test(value) || DESTRUCTIVE_OBJECT_TARGETS.test(value);
}

function hasMultiStepActionIntent(value: string): boolean {
  if (!MULTI_STEP_SECOND_ACTION.test(value)) return false;
  const hasFirstAction = TASK_CREATE_PATTERNS.test(value)
    || /\b(schedule|reschedule|plan|remind|agenda|agendar|programar|recordar)\b/i.test(value);
  return hasFirstAction;
}

function hasMultiRecipientAddIntent(value: string): boolean {
  const targetClauses = value.match(/\b(?:to|under|à|a|na|no|en|bajo)\b/gi) || [];
  return targetClauses.length > 1 && /\b(and|e|y)\b/i.test(value);
}

function extractQuotedSegments(value: string): string[] {
  const matches = [...value.matchAll(/"([^"]+)"|“([^”]+)”|'([^']+)'|‘([^’]+)’/g)];
  return matches
    .map((match) => (match[1] || match[2] || match[3] || match[4] || '').trim())
    .filter(Boolean);
}

function replaceQuotedSegments(value: string): string {
  let index = 0;
  return value.replace(/"([^"]+)"|“([^”]+)”|'([^']+)'|‘([^’]+)’/g, () => `__QUOTE_${index++}__`);
}

function removeQuotedSegments(value: string): string {
  return replaceQuotedSegments(value);
}

function normalizeTitle(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[:\-–—\s]+|[:\-–—\s.!?]+$/g, '')
    .slice(0, MAX_TASK_TITLE_LENGTH)
    .trim();
}

function normalizeSubtasks(value: unknown): string[] {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of input) {
    const normalized = normalizeTitle(item);
    if (!normalized) continue;
    const key = normalizeComparable(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized.slice(0, MAX_SUBTASK_TITLE_LENGTH).trim());
    if (output.length >= MAX_SUBTASKS) break;
  }
  return output;
}

function normalizeComparable(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function detectLanguage(value: string): CreateTaskWithSubtasksEntities['language'] {
  const hasPortuguese = /\b(cria|criar|crie|tarefa|subtarefas?|adiciona|por agora|é só isso)\b/i.test(value);
  const hasSpanish = /\b(crea|crear|tarea|subtareas?|añade|anade|agrega|con|llamada?|llamado?)\b/i.test(value);
  const hasEnglish = /\b(create|task|subtasks?|add|called|for now)\b/i.test(value);
  if ([hasPortuguese, hasSpanish, hasEnglish].filter(Boolean).length > 1) return 'mixed';
  if (hasSpanish) return 'es';
  if (hasPortuguese) return 'pt';
  if (hasEnglish) return 'en';
  return 'unknown';
}

function extractArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as any).tasks)) return (value as any).tasks;
  return [];
}

function containsAuthoritativeIdentityField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsAuthoritativeIdentityField);
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => (
    /^(user|tenant|owner|account)Id$/i.test(key) || containsAuthoritativeIdentityField(nested)
  ));
}

function stripAuthoritativeIdentityFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAuthoritativeIdentityFields);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/^(user|tenant|owner|account)Id$/i.test(key)) continue;
    output[key] = stripAuthoritativeIdentityFields(nested);
  }
  return output;
}

function assertUniqueManifests(manifests: ActionManifest[]): void {
  const seen = new Set<string>();
  for (const manifest of manifests) {
    const key = `${manifest.skill}:${manifest.action}`;
    if (seen.has(key)) throw new Error(`duplicate_chat_action_manifest:${key}`);
    seen.add(key);
  }
}

function mergeEntityRefs(existing: unknown[], additions: unknown[]): unknown[] {
  const refs = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(refs.map((ref: any) => `${ref?.entityType || ''}:${ref?.entityId || ''}:${ref?.parentTaskId || ''}`));
  for (const addition of additions) {
    const ref = addition as any;
    const key = `${ref?.entityType || ''}:${ref?.entityId || ''}:${ref?.parentTaskId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(addition);
  }
  return refs;
}

export function expireStaleChatActionPlans(): number {
  const result = getDb().prepare(`
    UPDATE chat_action_plans
    SET status = 'expired', updated_at = datetime('now')
    WHERE expires_at IS NOT NULL
      AND expires_at < datetime('now')
      AND status IN ('draft', 'awaiting_clarification', 'awaiting_confirmation', 'executing')
  `).run();
  return Number(result.changes || 0);
}

function safeJsonParse(value: unknown, fallback: unknown): any {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
