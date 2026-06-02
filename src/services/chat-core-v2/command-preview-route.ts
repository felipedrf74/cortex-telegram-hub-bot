// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  CHAT_CORE_V2_CONFIRMATIONS_FLAG,
  getChatCoreV2Capability,
  isChatCoreV2CapabilityEnabled,
} from './capability-registry';
import {
  evaluateChatCoreV2CommandBusGate,
  type ChatCoreV2CommandGateVerdict,
} from './command-bus';
import {
  decisionDismissVersionForItem,
  decisionSnoozeVersionForItem,
  isDecisionDismissEligibleStatus,
  isDecisionSnoozeEligibleStatus,
  isNotificationSnoozeEligibleStatus,
  notificationSnoozeVersionForItem,
} from './command-status-policy';
import {
  buildChatCoreV2ActionPreviewResponse,
  normalizeChatCoreV2Locale,
  type ChatCoreV2Response,
} from './response-contracts';
import {
  classifyShadowRoute,
  type ChatCoreV2ShadowRouteGuess,
} from './shadow-route-classifier';
import { resolveChatCoreV2ActivationConfig } from './activation-flags';
import { hashStable, normalizeTimezone } from './deterministic-read/common';
import { isChatCoreV2RuntimeFlagEnabled } from '../runtime-flags';
import { signChatConfirmationToken } from '../chat-confirmation-token';
import { trackPendingChatCoreV2Command } from './pending-commands';
import { getDb } from '../database';
import {
  buildEntityResolutionPreconditions,
  resolveEntityReferenceFromCandidates,
} from './entity-resolution';
import {
  foldCalendarText,
  parseNaturalLanguageCalendarEvent,
  type ParsedNaturalLanguageCalendarEvent,
} from '../calendar-natural-language-parser';
import { parseSimpleTaskStep } from '../chat/planner/simple-task';
import { parseTaskWithSubtasksIntent } from '../chat/planner/task-subtasks';
import {
  listDecisionItems,
  type DecisionApiItem,
} from '../decision-center';
import {
  listNotificationCenterItems,
  type NotificationCenterItem,
} from '../notification-orchestrator';
import { listTasks } from '../task-store/task-service';
import { computeContentHash } from '../task-store/unified-task-store';
import type { NormalizedTask } from '../task-store/types';
import {
  getActivePlan,
  getSessionsForWeek,
  getWeeksForPlan,
  type TrainingPlan,
  type TrainingSession,
  type TrainingWeek,
} from '../training-plans';
import {
  evaluateChatCoreV2TrainingSafetyPolicy,
  type TrainingChangeType,
} from './training-safety-policy';
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
  executionEnabled: boolean;
  executionDisabledReason?: 'preview_only_rollout' | 'executor_not_supported';
  confirmationToken?: string;
}

const TASK_CREATE_CAPABILITY = 'tasks.create';
const TASK_COMPLETE_CAPABILITY = 'tasks.complete';
const NOTIFICATION_SNOOZE_CAPABILITY = 'notifications.snooze';
const DECISION_DISMISS_CAPABILITY = 'decision_center.dismiss';
const DECISION_SNOOZE_CAPABILITY = 'decision_center.snooze';
const EXECUTABLE_CAPABILITIES = new Set([
  TASK_CREATE_CAPABILITY,
  TASK_COMPLETE_CAPABILITY,
  NOTIFICATION_SNOOZE_CAPABILITY,
  DECISION_DISMISS_CAPABILITY,
  DECISION_SNOOZE_CAPABILITY,
]);
const SECRETARY_SCHEDULE_EVENT_CAPABILITY = 'secretary.schedule_event_preview';
const TRAINING_MODIFY_SESSION_CAPABILITY = 'training.modify_session_preview';
const COOKING_GROCERY_ITEM_CAPABILITY = 'cooking.grocery_item_preview';
const CONTENT_BRIEF_DRAFT_CAPABILITY = 'content.brief_draft_preview';
const COMMAND_TTL_MS = 10 * 60 * 1000;
const NOTIFICATION_SNOOZE_DEFAULT_MINUTES = 60;
const ACTIVE_TRAINING_SESSION_STATUSES = new Set([
  'pending',
  'scheduled',
  'reflowed',
  'compressed',
  'capped',
  'moved',
]);
const DECISION_NOUN_SOURCE = String.raw`(?:decision|choice|decis(?:ao|oes|ão|ões|ion|ión|iones)|escolhas?|elecci(?:on|ón|ones))`;
const DECISION_NOUN_RE = new RegExp(String.raw`\b${DECISION_NOUN_SOURCE}\b`, 'gi');

type ChatCoreV2ResolvableTask = NormalizedTask & {
  id: number;
  providerData?: Record<string, unknown> & {
    chatCoreV2TaskStore?: 'unified_tasks' | 'native_tasks';
    nativeListId?: number;
  };
};

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
  if (routeGuess.domains[0] === 'decision_center') {
    if (routeGuess.intent === 'modify_action' && routeGuess.capabilityIds.includes(DECISION_DISMISS_CAPABILITY)) {
      return tryBuildDecisionDismissPreview(input, routeGuess);
    }
    if (routeGuess.intent === 'modify_action' && routeGuess.capabilityIds.includes(DECISION_SNOOZE_CAPABILITY)) {
      return tryBuildDecisionSnoozePreview(input, routeGuess);
    }
  }
  if (routeGuess.domains[0] === 'secretary') {
    if (routeGuess.intent === 'create_action' && routeGuess.capabilityIds.includes(SECRETARY_SCHEDULE_EVENT_CAPABILITY)) {
      return tryBuildSecretaryScheduleEventPreview(input, routeGuess);
    }
  }
  if (routeGuess.domains[0] === 'training') {
    if (routeGuess.intent === 'modify_action' && routeGuess.capabilityIds.includes(TRAINING_MODIFY_SESSION_CAPABILITY)) {
      return tryBuildTrainingModifySessionPreview(input, routeGuess);
    }
  }
  if (routeGuess.domains[0] === 'content') {
    if (routeGuess.intent === 'create_action' && routeGuess.capabilityIds.includes(CONTENT_BRIEF_DRAFT_CAPABILITY)) {
      return tryBuildContentBriefDraftPreview(input, routeGuess);
    }
  }
  if (routeGuess.domains[0] === 'cooking') {
    if (routeGuess.intent === 'create_action' && routeGuess.capabilityIds.includes(COOKING_GROCERY_ITEM_CAPABILITY)) {
      return tryBuildCookingGroceryItemPreview(input, routeGuess);
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
  const taskWithSubtasksPlan = parseTaskWithSubtasksIntent(plannerInput);
  const taskWithSubtasksStep = taskWithSubtasksPlan?.steps.find((step) => step.action === 'create_task_with_subtasks');
  if (taskWithSubtasksStep) {
    if (!taskWithSubtasksStep.requiredArgsPresent) return null;
    const command = buildTaskCreateCommandEnvelope({
      input,
      now,
      args: taskWithSubtasksStep.args,
      idempotencyKey: taskWithSubtasksStep.idempotencyKey,
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
  if (taskWithSubtasksPlan?.steps.some((step) => step.action === 'add_subtasks_to_task')) {
    return null;
  }
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

  const pendingTasks: ChatCoreV2ResolvableTask[] = [
    ...listTasks(input.userId, { status: 'pending' })
      .filter((task): task is NormalizedTask & { id: number } => Number.isFinite(task.id))
      .map((task) => ({
        ...task,
        providerData: {
          ...(task.providerData ?? {}),
          chatCoreV2TaskStore: 'unified_tasks' as const,
        },
      })),
    ...listNativeTasksForPreview(input.userId),
  ];
  const exactTitleMatches = pendingTasks.filter(
    (task) => normalizeTaskResolutionText(task.title) === normalizeTaskResolutionText(referencePhrase),
  );
  const candidates = pendingTasks
    .map((task) => taskToResolutionCandidate(task, referencePhrase))
    .filter((candidate) => candidate.confidence > 0.45);

  if (exactTitleMatches.length === 1) {
    const selectedCandidate = taskToResolutionCandidate(exactTitleMatches[0], referencePhrase);
    const resolution: EntityReferenceResolution = {
      entityType: 'task',
      userPhrase: referencePhrase,
      candidates: [selectedCandidate],
      status: 'resolved',
      selectedId: selectedCandidate.id,
      selectedCandidate,
      reasonCodes: ['exact_title_match'],
    };
    const now = input.now ?? new Date();
    const command = buildTaskCompleteCommandEnvelope({
      input,
      now,
      task: exactTitleMatches[0],
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

  if (exactTitleMatches.length > 1) {
    return null;
  }

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

  const notifications = [
    ...listNotificationCenterItems(input.userId, input.tenantId, { status: 'unread', limit: 50 }),
    ...listNotificationCenterItems(input.userId, input.tenantId, { status: 'read', limit: 50 }),
  ].filter((item) => isNotificationSnoozeEligibleStatus(item.status));
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

function tryBuildDecisionDismissPreview(
  input: BuildChatCoreV2CommandPreviewRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2CommandPreviewRouteResult | null {
  const capability = getEnabledCapability(DECISION_DISMISS_CAPABILITY, input);
  if (!capability) return null;

  const referencePhrase = extractDecisionDismissReference(input.normalizedText);
  if (!referencePhrase) return null;

  const decisions = listDecisionItems(input.userId, input.tenantId, { limit: 50 })
    .filter((item) => isDecisionDismissEligibleStatus(item.status));
  const candidates = decisions
    .map((item) => decisionToResolutionCandidate(item, referencePhrase))
    .filter((candidate) => candidate.confidence > 0.45);
  const resolution = resolveEntityReferenceFromCandidates({
    entityType: 'decision',
    userPhrase: referencePhrase,
    candidates,
  });
  if (resolution.status !== 'resolved' || !resolution.selectedCandidate) return null;

  const decisionId = decisionIdFromCandidate(resolution.selectedCandidate);
  const decision = decisions.find((candidateDecision) => candidateDecision.decisionId === decisionId);
  if (!decision) return null;

  const now = input.now ?? new Date();
  const command = buildDecisionDismissCommandEnvelope({
    input,
    now,
    decision,
    resolution,
  });
  return buildCommandPreviewResult({
    input,
    routeGuess,
    capability,
    capabilityId: DECISION_DISMISS_CAPABILITY,
    command,
    now,
  });
}

function tryBuildDecisionSnoozePreview(
  input: BuildChatCoreV2CommandPreviewRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2CommandPreviewRouteResult | null {
  const capability = getEnabledCapability(DECISION_SNOOZE_CAPABILITY, input);
  if (!capability) return null;

  const snoozeRequest = extractDecisionSnoozeRequest(input.normalizedText);
  const referencePhrase = snoozeRequest.referencePhrase;
  if (!referencePhrase) return null;

  const decisions = listDecisionItems(input.userId, input.tenantId, { limit: 50 })
    .filter((item) => isDecisionSnoozeEligibleStatus(item.status));
  const candidates = decisions
    .map((item) => decisionToResolutionCandidate(item, referencePhrase, 'snooze'))
    .filter((candidate) => candidate.confidence > 0.45);
  const resolution = resolveEntityReferenceFromCandidates({
    entityType: 'decision',
    userPhrase: referencePhrase,
    candidates,
  });
  if (resolution.status !== 'resolved' || !resolution.selectedCandidate) return null;

  const decisionId = decisionIdFromCandidate(resolution.selectedCandidate);
  const decision = decisions.find((candidateDecision) => candidateDecision.decisionId === decisionId);
  if (!decision) return null;

  const now = input.now ?? new Date();
  const command = buildDecisionSnoozeCommandEnvelope({
    input,
    now,
    decision,
    resolution,
    snoozeMinutes: snoozeRequest.snoozeMinutes,
  });
  return buildCommandPreviewResult({
    input,
    routeGuess,
    capability,
    capabilityId: DECISION_SNOOZE_CAPABILITY,
    command,
    now,
  });
}

function tryBuildSecretaryScheduleEventPreview(
  input: BuildChatCoreV2CommandPreviewRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2CommandPreviewRouteResult | null {
  const capability = getEnabledCapability(SECRETARY_SCHEDULE_EVENT_CAPABILITY, input);
  if (!capability) return null;

  const now = input.now ?? new Date();
  const event = parseNaturalLanguageCalendarEvent(input.normalizedText, {
    timezone: normalizeTimezone(input.timezone),
    nowIso: now.toISOString(),
  });
  if (!event) return null;
  if (!isConcreteCalendarEventTitle(event.title)) return null;

  const command = buildSecretaryScheduleEventCommandEnvelope({
    input,
    now,
    event,
  });
  return buildCommandPreviewResult({
    input,
    routeGuess,
    capability,
    capabilityId: SECRETARY_SCHEDULE_EVENT_CAPABILITY,
    command,
    now,
  });
}

function isConcreteCalendarEventTitle(title: string): boolean {
  const normalized = foldCalendarText(title)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  return !/^(?:something|anything|event|meeting|appointment|calendar|agenda|reuniao|cita|evento|compromisso)$/.test(normalized);
}

function tryBuildTrainingModifySessionPreview(
  input: BuildChatCoreV2CommandPreviewRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2CommandPreviewRouteResult | null {
  const capability = getEnabledCapability(TRAINING_MODIFY_SESSION_CAPABILITY, input);
  if (!capability) return null;

  const changeTypes = extractTrainingChangeTypes(input.normalizedText);
  if (changeTypes.length === 0) return null;

  const now = input.now ?? new Date();
  const target = resolveTrainingSessionTarget(input, now);
  if (!target) return null;

  const policy = evaluateChatCoreV2TrainingSafetyPolicy({
    operation: 'preview',
    changeTypes,
    affectedSessionCount: 1,
    targetSessionIds: [`training_session:${target.session.id}`],
    increasesIntensity: false,
    increasesVolumePercent: 0,
  });
  if (!policy.ok) return null;

  const command = buildTrainingModifySessionCommandEnvelope({
    input,
    now,
    target,
    changeTypes,
    policyVersion: policy.policyVersion,
  });
  return buildCommandPreviewResult({
    input,
    routeGuess,
    capability,
    capabilityId: TRAINING_MODIFY_SESSION_CAPABILITY,
    command,
    now,
  });
}

function tryBuildCookingGroceryItemPreview(
  input: BuildChatCoreV2CommandPreviewRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2CommandPreviewRouteResult | null {
  const capability = getEnabledCapability(COOKING_GROCERY_ITEM_CAPABILITY, input);
  if (!capability) return null;

  const groceryItems = extractCookingGroceryItems(input.normalizedText);
  if (groceryItems.length === 0) return null;

  const now = input.now ?? new Date();
  const command = buildCookingGroceryItemCommandEnvelope({
    input,
    now,
    items: groceryItems,
  });
  return buildCommandPreviewResult({
    input,
    routeGuess,
    capability,
    capabilityId: COOKING_GROCERY_ITEM_CAPABILITY,
    command,
    now,
  });
}

function tryBuildContentBriefDraftPreview(
  input: BuildChatCoreV2CommandPreviewRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2CommandPreviewRouteResult | null {
  const capability = getEnabledCapability(CONTENT_BRIEF_DRAFT_CAPABILITY, input);
  if (!capability) return null;

  const brief = extractContentBriefDraft(input.normalizedText);
  if (!brief) return null;

  const now = input.now ?? new Date();
  const command = buildContentBriefDraftCommandEnvelope({
    input,
    now,
    brief,
  });
  return buildCommandPreviewResult({
    input,
    routeGuess,
    capability,
    capabilityId: CONTENT_BRIEF_DRAFT_CAPABILITY,
    command,
    now,
  });
}

function getEnabledCapability(
  capabilityId: string,
  input: BuildChatCoreV2CommandPreviewRouteInput,
): CapabilityDefinition | null {
  const capability = getChatCoreV2Capability(capabilityId) ?? null;
  if (!isChatCoreV2CapabilityEnabled(capabilityId, {
    env: input.env ?? process.env,
    scope: { userId: input.userId, tenantId: input.tenantId },
  })) {
    const activation = resolveChatCoreV2ActivationConfig(input.env ?? process.env);
    if (
      !capability
      || (activation.mode !== 'canary' && activation.mode !== 'on')
      || !activation.allowWritePreviews
      || !activation.allowedDomains.includes(capability.domain)
    ) {
      return null;
    }
  }

  return capability;
}

function buildCommandPreviewResult(input: {
  input: BuildChatCoreV2CommandPreviewRouteInput;
  routeGuess: ChatCoreV2ShadowRouteGuess;
  capability: CapabilityDefinition;
  capabilityId: string;
  command: AICommandEnvelope<Record<string, unknown>>;
  now: Date;
  forcePreviewOnly?: boolean;
}): ChatCoreV2CommandPreviewRouteResult | null {
  const command = input.command;
  const gateVerdict = evaluateChatCoreV2CommandBusGate(command, {
    actorUserId: String(input.input.userId),
    tenantId: String(input.input.tenantId),
    delegatedScopes: command.authorization.delegatedScopes,
    permissionSnapshotVersion: command.authorization.permissionSnapshotVersion,
    currentEntityVersions: command.preconditions.requiredEntityVersions,
    decisionVersion: command.preconditions.requiredDecisionVersion,
    invariantResults: Object.fromEntries(command.preconditions.invariants.map((invariant) => [invariant.check, true])),
    now: input.now,
  }, 'preview');
  if (!gateVerdict.ok) return null;

  const confirmation = input.forcePreviewOnly
    ? { executionEnabled: false as const, executionDisabledReason: 'preview_only_rollout' as const }
    : maybeIssueConfirmationToken({
      input: input.input,
      capability: input.capability,
      capabilityId: input.capabilityId,
      command,
      now: input.now,
    });
  const previewCapability = confirmation.executionEnabled ? input.capability : asPreviewOnlyCapability(input.capability);
  const previewCopy = buildPreviewCopy(input.capabilityId, command.payload, input.input.locale);
  const response = buildChatCoreV2ActionPreviewResponse({
    capability: previewCapability,
    command,
    title: previewCopy.title,
    summary: previewCopy.summary,
    diff: previewCopy.diff,
    locale: input.input.locale,
    confirmationToken: confirmation.confirmationToken,
    expiresAt: command.expiresAt,
  });
  if (!confirmation.executionEnabled) {
    response.reasonCodes = [
      ...response.reasonCodes,
      'preview_only_rollout',
    ];
  } else {
    response.reasonCodes = [...response.reasonCodes, 'confirmation_required'];
  }

  return {
    routeVersion: CHAT_CORE_V2_COMMAND_PREVIEW_ROUTE_VERSION,
    capabilityId: input.capabilityId,
    routeGuess: input.routeGuess,
    command,
    gateVerdict,
    response,
    executionEnabled: confirmation.executionEnabled,
    executionDisabledReason: confirmation.executionDisabledReason,
    confirmationToken: confirmation.confirmationToken,
  };
}

function maybeIssueConfirmationToken(input: {
  input: BuildChatCoreV2CommandPreviewRouteInput;
  capability: CapabilityDefinition;
  capabilityId: string;
  command: AICommandEnvelope<Record<string, unknown>>;
  now: Date;
}): {
  executionEnabled: boolean;
  executionDisabledReason?: ChatCoreV2CommandPreviewRouteResult['executionDisabledReason'];
  confirmationToken?: string;
} {
  if (input.capability.support.execute !== 'supported') {
    return { executionEnabled: false, executionDisabledReason: 'preview_only_rollout' };
  }
  const flagEnabled = isChatCoreV2RuntimeFlagEnabled(CHAT_CORE_V2_CONFIRMATIONS_FLAG, input.input.env ?? process.env, {
    userId: input.input.userId,
    tenantId: input.input.tenantId,
  });
  if (!flagEnabled) {
    return { executionEnabled: false, executionDisabledReason: 'preview_only_rollout' };
  }
  if (!EXECUTABLE_CAPABILITIES.has(input.capabilityId)) {
    return { executionEnabled: false, executionDisabledReason: 'executor_not_supported' };
  }

  trackPendingChatCoreV2Command({
    userId: input.input.userId,
    tenantId: input.input.tenantId,
    capabilityId: input.capabilityId,
    command: input.command,
    normalizedText: input.input.normalizedText,
    locale: input.input.locale ?? null,
    timezone: input.input.timezone,
    conversationId: input.input.conversationId,
    messageId: input.input.messageId,
    now: input.now,
  });
  return {
    executionEnabled: true,
    confirmationToken: signChatConfirmationToken({
      pendingId: input.command.commandId,
      userId: input.input.userId,
      tenantId: input.input.tenantId,
      intentClass: input.command.commandType,
      expiresAt: input.command.expiresAt,
      sourceMessageId: input.input.messageId,
      now: input.now,
    }),
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
    ...(Array.isArray(input.args.subtasks) ? {
      subtasks: input.args.subtasks.map((subtask) => String(subtask).trim()).filter(Boolean).slice(0, 25),
    } : {}),
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
  task: ChatCoreV2ResolvableTask;
  relatedTasks?: ChatCoreV2ResolvableTask[];
  resolution: EntityReferenceResolution;
}): AICommandEnvelope<Record<string, unknown>> {
  const entityPreconditions = buildEntityResolutionPreconditions(input.resolution);
  const taskStore = input.task.providerData?.chatCoreV2TaskStore === 'native_tasks' ? 'native_tasks' : 'unified_tasks';
  const nativeListId = typeof input.task.providerData?.nativeListId === 'number'
    ? input.task.providerData.nativeListId
    : null;
  const relatedTasks = input.relatedTasks?.length ? input.relatedTasks : [input.task];
  const relatedEntityVersions = Object.fromEntries(
    relatedTasks.map((task) => [taskEntityId(task), computeContentHash(task)]),
  );
  const requiredEntityVersions = {
    ...entityPreconditions.requiredEntityVersions,
    ...relatedEntityVersions,
  };
  const relatedPayload = relatedTasks.map((task) => ({
    taskStore: task.providerData?.chatCoreV2TaskStore === 'native_tasks' ? 'native_tasks' : 'unified_tasks',
    taskId: task.id,
    nativeListId: typeof task.providerData?.nativeListId === 'number' ? task.providerData.nativeListId : null,
    title: task.title,
    currentStatus: task.status,
  }));
  const createdAt = input.now.toISOString();
  const payload = {
    operation: 'complete',
    taskStore,
    taskId: input.task.id,
    nativeListId,
    title: input.task.title,
    currentStatus: input.task.status,
    targetStatus: 'completed',
    dueDateTime: input.task.dueIsDatetime ? input.task.dueDate ?? null : null,
    dueDate: input.task.dueIsDatetime ? null : input.task.dueDate ?? null,
    duplicateTasks: relatedPayload.length > 1 ? relatedPayload : undefined,
  };
  const commandId = `cmd_${hashStable({
    tenantId: input.input.tenantId,
    userId: input.input.userId,
    messageId: input.input.messageId,
    taskIds: relatedTasks.map((task) => task.id),
    entityVersions: requiredEntityVersions,
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
      entityIds: relatedTasks.map(taskEntityId),
      entityVersions: requiredEntityVersions,
      contextHash: hashStable({
        routeVersion: CHAT_CORE_V2_COMMAND_PREVIEW_ROUTE_VERSION,
        textHash: hashStable({ text: input.input.normalizedText }),
        payload,
        resolution: input.resolution.reasonCodes,
      }),
      createdAt,
    },
    preconditions: {
      requiredEntityVersions,
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
    idempotencyKey: `chat-v2:${input.input.tenantId}:${input.input.userId}:tasks.complete:${relatedTasks.map((task) => task.id).join(',')}:${commandId}`,
  };
}

function taskEntityId(task: ChatCoreV2ResolvableTask): string {
  return task.providerData?.chatCoreV2TaskStore === 'native_tasks'
    ? `native_task:${task.id}`
    : `task:${task.id}`;
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
        description: 'Notification must still be snooze-eligible when the preview is confirmed.',
        check: 'notification_is_snooze_eligible',
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

function buildDecisionDismissCommandEnvelope(input: {
  input: BuildChatCoreV2CommandPreviewRouteInput;
  now: Date;
  decision: DecisionApiItem;
  resolution: EntityReferenceResolution;
}): AICommandEnvelope<Record<string, unknown>> {
  const entityPreconditions = buildEntityResolutionPreconditions(input.resolution);
  const entityId = `decision:${input.decision.decisionId}`;
  const createdAt = input.now.toISOString();
  const decisionVersion = decisionDismissVersionForItem(input.decision);
  const payload = {
    operation: 'dismiss',
    decisionId: input.decision.decisionId,
    title: input.decision.title,
    currentStatus: input.decision.status,
    targetStatus: 'dismissed',
    sourceSkill: input.decision.sourceSkill,
    type: input.decision.type,
    urgency: input.decision.urgency,
    recommendedActionLabel: input.decision.recommendedActionLabel,
  };
  const commandId = `cmd_${hashStable({
    tenantId: input.input.tenantId,
    userId: input.input.userId,
    messageId: input.input.messageId,
    decisionId: input.decision.decisionId,
    decisionVersion,
    entityVersions: entityPreconditions.requiredEntityVersions,
  })}`;

  return {
    commandId,
    commandSchemaVersion: 'decision_center.dismiss@1.0.0',
    previewSchemaVersion: 'decision_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: String(input.input.tenantId),
    userId: String(input.input.userId),
    domain: 'decision_center',
    commandType: 'decision_center.dismiss',
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
      requiredPermissionsVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:decision_center:v1`,
      requiredDecisionVersion: decisionVersion,
      invariants: [{
        type: 'decision_status',
        description: 'Decision must still be dismissible when the preview is confirmed.',
        check: 'decision_is_active',
      }],
    },
    authorization: {
      actorUserId: String(input.input.userId),
      tenantId: String(input.input.tenantId),
      actingSurface: 'ios_chat',
      delegatedScopes: ['decision_center:read', 'decision_center:write'],
      permissionSnapshotVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:decision_center:v1`,
      authTime: createdAt,
    },
    expiresAt: new Date(input.now.getTime() + COMMAND_TTL_MS).toISOString(),
    idempotencyKey: `chat-v2:${input.input.tenantId}:${input.input.userId}:decision_center.dismiss:${input.decision.decisionId}:${commandId}`,
  };
}

function buildDecisionSnoozeCommandEnvelope(input: {
  input: BuildChatCoreV2CommandPreviewRouteInput;
  now: Date;
  decision: DecisionApiItem;
  resolution: EntityReferenceResolution;
  snoozeMinutes: number;
}): AICommandEnvelope<Record<string, unknown>> {
  const entityPreconditions = buildEntityResolutionPreconditions(input.resolution);
  const entityId = `decision:${input.decision.decisionId}`;
  const createdAt = input.now.toISOString();
  const decisionVersion = decisionSnoozeVersionForItem(input.decision);
  const snoozeMinutes = normalizeSnoozeMinutes(input.snoozeMinutes);
  const snoozedUntil = new Date(input.now.getTime() + snoozeMinutes * 60_000).toISOString();
  const payload = {
    operation: 'snooze',
    decisionId: input.decision.decisionId,
    title: input.decision.title,
    currentStatus: input.decision.status,
    targetStatus: 'snoozed',
    sourceSkill: input.decision.sourceSkill,
    type: input.decision.type,
    urgency: input.decision.urgency,
    recommendedActionLabel: input.decision.recommendedActionLabel,
    snoozeMinutes,
    snoozedUntil,
  };
  const commandId = `cmd_${hashStable({
    tenantId: input.input.tenantId,
    userId: input.input.userId,
    messageId: input.input.messageId,
    decisionId: input.decision.decisionId,
    decisionVersion,
    snoozeMinutes,
    entityVersions: entityPreconditions.requiredEntityVersions,
  })}`;

  return {
    commandId,
    commandSchemaVersion: 'decision_center.snooze@1.0.0',
    previewSchemaVersion: 'decision_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: String(input.input.tenantId),
    userId: String(input.input.userId),
    domain: 'decision_center',
    commandType: 'decision_center.snooze',
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
      requiredPermissionsVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:decision_center:v1`,
      requiredDecisionVersion: decisionVersion,
      invariants: [{
        type: 'decision_status',
        description: 'Decision must still be snooze-eligible when the preview is confirmed.',
        check: 'decision_is_snooze_eligible',
      }],
    },
    authorization: {
      actorUserId: String(input.input.userId),
      tenantId: String(input.input.tenantId),
      actingSurface: 'ios_chat',
      delegatedScopes: ['decision_center:read', 'decision_center:write'],
      permissionSnapshotVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:decision_center:v1`,
      authTime: createdAt,
    },
    expiresAt: new Date(input.now.getTime() + COMMAND_TTL_MS).toISOString(),
    idempotencyKey: `chat-v2:${input.input.tenantId}:${input.input.userId}:decision_center.snooze:${input.decision.decisionId}:${snoozeMinutes}:${commandId}`,
  };
}

function buildSecretaryScheduleEventCommandEnvelope(input: {
  input: BuildChatCoreV2CommandPreviewRouteInput;
  now: Date;
  event: ParsedNaturalLanguageCalendarEvent;
}): AICommandEnvelope<Record<string, unknown>> {
  const createdAt = input.now.toISOString();
  const provider = input.event.provider === 'outlook' ? 'outlook_calendar' : 'google_calendar';
  const payload = {
    operation: 'schedule_event',
    title: input.event.title,
    provider,
    calendarId: 'primary',
    startDateTime: input.event.startDateTime,
    endDateTime: input.event.endDateTime,
    timezone: input.event.timezone,
    attendees: input.event.attendees,
    location: input.event.location,
    notes: input.event.notes,
    recurrence: input.event.recurrence,
    status: 'preview',
  };
  const commandId = `cmd_${hashStable({
    tenantId: input.input.tenantId,
    userId: input.input.userId,
    messageId: input.input.messageId,
    payload,
  })}`;

  return {
    commandId,
    commandSchemaVersion: 'secretary.schedule_event@1.0.0',
    previewSchemaVersion: 'calendar_change_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: String(input.input.tenantId),
    userId: String(input.input.userId),
    domain: 'secretary',
    commandType: 'secretary.schedule_event',
    origin: 'chat',
    payload,
    basedOn: {
      entityIds: [`calendar_event_draft:${commandId}`],
      entityVersions: {},
      contextHash: hashStable({
        routeVersion: CHAT_CORE_V2_COMMAND_PREVIEW_ROUTE_VERSION,
        textHash: hashStable({ text: input.input.normalizedText }),
        payload,
        parserConfidence: input.event.confidence,
      }),
      createdAt,
    },
    preconditions: {
      requiredEntityVersions: {},
      requiredPermissionsVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:secretary:v1`,
      invariants: [{
        type: 'preview_only',
        description: 'Secretary calendar previews do not create events or invite attendees in this rollout.',
        check: 'secretary_schedule_event_preview_only',
      }],
    },
    authorization: {
      actorUserId: String(input.input.userId),
      tenantId: String(input.input.tenantId),
      actingSurface: 'ios_chat',
      delegatedScopes: ['secretary:read'],
      permissionSnapshotVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:secretary:v1`,
      authTime: createdAt,
    },
    expiresAt: new Date(input.now.getTime() + COMMAND_TTL_MS).toISOString(),
    idempotencyKey: `chat-v2:${input.input.tenantId}:${input.input.userId}:secretary.schedule_event:${commandId}`,
  };
}

function buildCookingGroceryItemCommandEnvelope(input: {
  input: BuildChatCoreV2CommandPreviewRouteInput;
  now: Date;
  items: string[];
}): AICommandEnvelope<Record<string, unknown>> {
  const createdAt = input.now.toISOString();
  const weekStart = weekStartForDate(dateKey(input.now, normalizeTimezone(input.input.timezone)));
  const payload = {
    operation: 'add_items',
    items: input.items,
    itemCount: input.items.length,
    weekStart,
    list: 'grocery',
  };
  const commandId = `cmd_${hashStable({
    tenantId: input.input.tenantId,
    userId: input.input.userId,
    messageId: input.input.messageId,
    items: input.items,
    weekStart,
  })}`;

  return {
    commandId,
    commandSchemaVersion: 'cooking.grocery_item@1.0.0',
    previewSchemaVersion: 'grocery_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: String(input.input.tenantId),
    userId: String(input.input.userId),
    domain: 'cooking',
    commandType: 'cooking.grocery_item',
    origin: 'chat',
    payload,
    basedOn: {
      entityIds: [`cooking_grocery_draft:${commandId}`],
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
      requiredPermissionsVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:cooking:v1`,
      invariants: [{
        type: 'preview_only',
        description: 'Grocery item previews do not mutate the shopping list in this rollout.',
        check: 'cooking_grocery_preview_only',
      }],
    },
    authorization: {
      actorUserId: String(input.input.userId),
      tenantId: String(input.input.tenantId),
      actingSurface: 'ios_chat',
      delegatedScopes: ['cooking:read'],
      permissionSnapshotVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:cooking:v1`,
      authTime: createdAt,
    },
    expiresAt: new Date(input.now.getTime() + COMMAND_TTL_MS).toISOString(),
    idempotencyKey: `chat-v2:${input.input.tenantId}:${input.input.userId}:cooking.grocery_item:${weekStart}:${commandId}`,
  };
}

function buildContentBriefDraftCommandEnvelope(input: {
  input: BuildChatCoreV2CommandPreviewRouteInput;
  now: Date;
  brief: ContentBriefDraft;
}): AICommandEnvelope<Record<string, unknown>> {
  const createdAt = input.now.toISOString();
  const payload = {
    operation: 'draft_brief',
    topic: input.brief.topic,
    objective: input.brief.objective,
    format: input.brief.format,
    status: 'preview',
  };
  const commandId = `cmd_${hashStable({
    tenantId: input.input.tenantId,
    userId: input.input.userId,
    messageId: input.input.messageId,
    payload,
  })}`;

  return {
    commandId,
    commandSchemaVersion: 'content.brief_draft@1.0.0',
    previewSchemaVersion: 'content_brief_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: String(input.input.tenantId),
    userId: String(input.input.userId),
    domain: 'content',
    commandType: 'content.brief_draft',
    origin: 'chat',
    payload,
    basedOn: {
      entityIds: [`content_brief_draft:${commandId}`],
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
      requiredPermissionsVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:content:v1`,
      invariants: [{
        type: 'preview_only',
        description: 'Content brief previews do not create drafts, scripts, or publishable content in this rollout.',
        check: 'content_brief_preview_only',
      }],
    },
    authorization: {
      actorUserId: String(input.input.userId),
      tenantId: String(input.input.tenantId),
      actingSurface: 'ios_chat',
      delegatedScopes: ['content:read'],
      permissionSnapshotVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:content:v1`,
      authTime: createdAt,
    },
    expiresAt: new Date(input.now.getTime() + COMMAND_TTL_MS).toISOString(),
    idempotencyKey: `chat-v2:${input.input.tenantId}:${input.input.userId}:content.brief_draft:${commandId}`,
  };
}

interface TrainingSessionPreviewTarget {
  plan: TrainingPlan;
  week: TrainingWeek;
  session: TrainingSession;
  sessionDate: string | null;
  sessionDateLabel: string;
  entityVersions: Record<string, string>;
}

function buildTrainingModifySessionCommandEnvelope(input: {
  input: BuildChatCoreV2CommandPreviewRouteInput;
  now: Date;
  target: TrainingSessionPreviewTarget;
  changeTypes: TrainingChangeType[];
  policyVersion: string;
}): AICommandEnvelope<Record<string, unknown>> {
  const createdAt = input.now.toISOString();
  const entityId = `training_session:${input.target.session.id}`;
  const planEntityId = `training_plan:${input.target.plan.id}`;
  const payload = {
    operation: 'modify_session',
    changeType: 'reduce_intensity',
    sessionId: input.target.session.id,
    planId: input.target.plan.id,
    weekId: input.target.week.id,
    title: input.target.session.title,
    dayOfWeek: input.target.session.day_of_week,
    sessionDate: input.target.sessionDate,
    sessionDateLabel: input.target.sessionDateLabel,
    sessionType: input.target.session.session_type,
    currentIntensity: input.target.session.intensity_text ?? null,
    targetIntensity: 'easier',
    currentDurationMinutes: input.target.session.duration_minutes,
    status: 'preview',
    safetyPolicyVersion: input.policyVersion,
    changes: {
      intensity: 'reduce',
      load: 'lighter',
      notes: 'Preview only. Training safety rules must validate any future execution.',
    },
  };
  const commandId = `cmd_${hashStable({
    tenantId: input.input.tenantId,
    userId: input.input.userId,
    messageId: input.input.messageId,
    sessionId: input.target.session.id,
    entityVersions: input.target.entityVersions,
    changeTypes: input.changeTypes,
  })}`;

  return {
    commandId,
    commandSchemaVersion: 'training.modify_session@1.0.0',
    previewSchemaVersion: 'training_change_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: String(input.input.tenantId),
    userId: String(input.input.userId),
    domain: 'training',
    commandType: 'training.modify_session',
    origin: 'chat',
    payload,
    basedOn: {
      entityIds: [entityId, planEntityId],
      entityVersions: input.target.entityVersions,
      contextHash: hashStable({
        routeVersion: CHAT_CORE_V2_COMMAND_PREVIEW_ROUTE_VERSION,
        textHash: hashStable({ text: input.input.normalizedText }),
        payload,
        changeTypes: input.changeTypes,
      }),
      createdAt,
    },
    preconditions: {
      requiredEntityVersions: input.target.entityVersions,
      requiredPermissionsVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:training:v1`,
      invariants: [
        {
          type: 'training_session_status',
          description: 'Training session must still be active before any future execution.',
          check: 'training_session_is_active',
        },
        {
          type: 'training_safety_policy',
          description: 'Training safety policy must allow the proposed modification before execution.',
          check: 'training_safety_policy_allows_change',
        },
        {
          type: 'preview_only',
          description: 'Training session modification previews do not change the plan in this rollout.',
          check: 'training_modify_session_preview_only',
        },
      ],
    },
    authorization: {
      actorUserId: String(input.input.userId),
      tenantId: String(input.input.tenantId),
      actingSurface: 'ios_chat',
      delegatedScopes: ['training:read'],
      permissionSnapshotVersion: `chat-v2-permissions:${input.input.tenantId}:${input.input.userId}:training:v1`,
      authTime: createdAt,
    },
    expiresAt: new Date(input.now.getTime() + COMMAND_TTL_MS).toISOString(),
    idempotencyKey: `chat-v2:${input.input.tenantId}:${input.input.userId}:training.modify_session:${input.target.session.id}:${commandId}`,
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
  if (capabilityId === SECRETARY_SCHEDULE_EVENT_CAPABILITY) {
    return {
      title: secretarySchedulePreviewTitle(payload, locale),
      summary: secretarySchedulePreviewSummary(payload, locale),
      diff: secretarySchedulePreviewDiff(payload, locale),
    };
  }
  if (capabilityId === TRAINING_MODIFY_SESSION_CAPABILITY) {
    return {
      title: trainingModifyPreviewTitle(payload, locale),
      summary: trainingModifyPreviewSummary(payload, locale),
      diff: trainingModifyPreviewDiff(payload, locale),
    };
  }
  if (capabilityId === CONTENT_BRIEF_DRAFT_CAPABILITY) {
    return {
      title: contentBriefPreviewTitle(payload, locale),
      summary: contentBriefPreviewSummary(payload, locale),
      diff: contentBriefPreviewDiff(payload, locale),
    };
  }
  if (capabilityId === COOKING_GROCERY_ITEM_CAPABILITY) {
    return {
      title: cookingGroceryPreviewTitle(payload, locale),
      summary: cookingGroceryPreviewSummary(payload, locale),
      diff: cookingGroceryPreviewDiff(payload, locale),
    };
  }
  if (capabilityId === DECISION_DISMISS_CAPABILITY) {
    return {
      title: decisionPreviewTitle(payload, locale),
      summary: decisionPreviewSummary(payload, locale),
      diff: decisionPreviewDiff(payload, locale),
    };
  }
  if (capabilityId === DECISION_SNOOZE_CAPABILITY) {
    return {
      title: decisionSnoozePreviewTitle(payload, locale),
      summary: decisionSnoozePreviewSummary(payload, locale),
      diff: decisionSnoozePreviewDiff(payload, locale),
    };
  }
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

function secretarySchedulePreviewTitle(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const normalized = normalizeChatCoreV2Locale(locale);
  const title = calendarEventTitle(payload);
  if (normalized === 'pt-BR') return `Prévia da agenda: ${title}`;
  if (normalized === 'pt-PT') return `Pré-visualização da agenda: ${title}`;
  if (normalized === 'es') return `Vista previa de agenda: ${title}`;
  return `Calendar preview: ${title}`;
}

function secretarySchedulePreviewSummary(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const normalized = normalizeChatCoreV2Locale(locale);
  const title = calendarEventTitle(payload);
  const start = formatCalendarPreviewDateTime(payload.startDateTime, payload.timezone, locale);
  const end = formatCalendarPreviewDateTime(payload.endDateTime, payload.timezone, locale);
  if (normalized === 'pt-BR') return `Eu prepararia "${title}" de ${start} até ${end}. Nenhum evento ou convite seria criado ainda.`;
  if (normalized === 'pt-PT') return `Eu prepararia "${title}" de ${start} até ${end}. Nenhum evento ou convite seria criado ainda.`;
  if (normalized === 'es') return `Prepararía "${title}" de ${start} a ${end}. Todavía no se crearía ningún evento ni invitación.`;
  return `I would prepare "${title}" from ${start} to ${end}. No calendar event or invite would be created yet.`;
}

function secretarySchedulePreviewDiff(payload: Record<string, unknown>, locale: string | null | undefined): Array<{ label: string; before?: string; after: string }> {
  const normalized = normalizeChatCoreV2Locale(locale);
  const labels = normalized === 'pt-BR'
    ? { event: 'Evento', start: 'Início', end: 'Fim', calendar: 'Agenda', attendees: 'Convidados', status: 'Estado', preview: 'Prévia' }
    : normalized === 'pt-PT'
      ? { event: 'Evento', start: 'Início', end: 'Fim', calendar: 'Agenda', attendees: 'Convidados', status: 'Estado', preview: 'Pré-visualização' }
      : normalized === 'es'
        ? { event: 'Evento', start: 'Inicio', end: 'Fin', calendar: 'Calendario', attendees: 'Invitados', status: 'Estado', preview: 'Vista previa' }
        : { event: 'Event', start: 'Start', end: 'End', calendar: 'Calendar', attendees: 'Guests', status: 'Status', preview: 'Preview' };
  const attendees = calendarAttendees(payload);
  return [
    { label: labels.event, after: calendarEventTitle(payload) },
    { label: labels.start, after: formatCalendarPreviewDateTime(payload.startDateTime, payload.timezone, locale) },
    { label: labels.end, after: formatCalendarPreviewDateTime(payload.endDateTime, payload.timezone, locale) },
    { label: labels.calendar, after: calendarProviderLabel(payload.provider, locale) },
    ...(attendees.length > 0 ? [{ label: labels.attendees, after: attendees.join(', ') }] : []),
    { label: labels.status, after: labels.preview },
  ];
}

function calendarEventTitle(payload: Record<string, unknown>): string {
  const title = String(payload.title ?? '').trim();
  return title || 'Untitled';
}

function calendarAttendees(payload: Record<string, unknown>): string[] {
  return Array.isArray(payload.attendees)
    ? payload.attendees.map((attendee) => String(attendee).trim()).filter(Boolean)
    : [];
}

function calendarProviderLabel(value: unknown, locale: string | null | undefined): string {
  const provider = String(value ?? '').trim();
  if (provider === 'outlook_calendar') return 'Outlook';
  if (provider === 'google_calendar') return 'Google';
  const normalized = normalizeChatCoreV2Locale(locale);
  return normalized === 'es' ? 'Calendario' : normalized.startsWith('pt') ? 'Agenda' : 'Calendar';
}

function formatCalendarPreviewDateTime(value: unknown, timezone: unknown, locale: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return raw;
  const normalized = normalizeChatCoreV2Locale(locale);
  const localeTag = normalized === 'pt-BR'
    ? 'pt-BR'
    : normalized === 'pt-PT'
      ? 'pt-PT'
      : normalized === 'es'
        ? 'es-ES'
        : 'en-GB';
  try {
    return new Intl.DateTimeFormat(localeTag, {
      timeZone: normalizeTimezone(String(timezone ?? 'UTC')),
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return raw;
  }
}

function trainingModifyPreviewTitle(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const normalized = normalizeChatCoreV2Locale(locale);
  const title = trainingSessionTitle(payload);
  if (normalized === 'pt-BR') return `Prévia do treino: ${title}`;
  if (normalized === 'pt-PT') return `Pré-visualização do treino: ${title}`;
  if (normalized === 'es') return `Vista previa de entrenamiento: ${title}`;
  return `Training preview: ${title}`;
}

function trainingModifyPreviewSummary(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const normalized = normalizeChatCoreV2Locale(locale);
  const title = trainingSessionTitle(payload);
  const when = String(payload.sessionDateLabel ?? payload.dayOfWeek ?? '').trim();
  if (normalized === 'pt-BR') return `Eu prepararia uma versão mais leve de "${title}"${when ? ` para ${when}` : ''}. O plano de treino ainda não seria alterado.`;
  if (normalized === 'pt-PT') return `Eu prepararia uma versão mais leve de "${title}"${when ? ` para ${when}` : ''}. O plano de treino ainda não seria alterado.`;
  if (normalized === 'es') return `Prepararía una versión más suave de "${title}"${when ? ` para ${when}` : ''}. El plan de entrenamiento todavía no cambiaría.`;
  return `I would prepare a lighter version of "${title}"${when ? ` for ${when}` : ''}. Your training plan would not change yet.`;
}

function trainingModifyPreviewDiff(payload: Record<string, unknown>, locale: string | null | undefined): Array<{ label: string; before?: string; after: string }> {
  const normalized = normalizeChatCoreV2Locale(locale);
  const labels = normalized === 'pt-BR'
    ? { session: 'Sessão', when: 'Quando', intensity: 'Intensidade', current: 'Atual', easier: 'Mais leve', status: 'Estado', preview: 'Prévia' }
    : normalized === 'pt-PT'
      ? { session: 'Sessão', when: 'Quando', intensity: 'Intensidade', current: 'Atual', easier: 'Mais leve', status: 'Estado', preview: 'Pré-visualização' }
      : normalized === 'es'
        ? { session: 'Sesión', when: 'Cuándo', intensity: 'Intensidad', current: 'Actual', easier: 'Más suave', status: 'Estado', preview: 'Vista previa' }
        : { session: 'Session', when: 'When', intensity: 'Intensity', current: 'Current', easier: 'Easier', status: 'Status', preview: 'Preview' };
  const currentIntensity = String(payload.currentIntensity ?? '').trim() || labels.current;
  const when = String(payload.sessionDateLabel ?? payload.dayOfWeek ?? '').trim();
  return [
    { label: labels.session, after: trainingSessionTitle(payload) },
    ...(when ? [{ label: labels.when, after: when }] : []),
    { label: labels.intensity, before: currentIntensity, after: labels.easier },
    { label: labels.status, after: labels.preview },
  ];
}

function trainingSessionTitle(payload: Record<string, unknown>): string {
  const title = String(payload.title ?? '').trim();
  return title || 'Training session';
}

function contentBriefPreviewTitle(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const normalized = normalizeChatCoreV2Locale(locale);
  const topic = contentBriefTopic(payload);
  if (normalized === 'pt-BR') return `Prévia de briefing de conteúdo: ${topic}`;
  if (normalized === 'pt-PT') return `Pré-visualização de briefing de conteúdo: ${topic}`;
  if (normalized === 'es') return `Vista previa de brief de contenido: ${topic}`;
  return `Content brief preview: ${topic}`;
}

function contentBriefPreviewSummary(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const normalized = normalizeChatCoreV2Locale(locale);
  const topic = contentBriefTopic(payload);
  if (normalized === 'pt-BR') return `Eu prepararia um briefing de conteúdo sobre ${topic}. Nada seria criado ou publicado ainda.`;
  if (normalized === 'pt-PT') return `Eu prepararia um briefing de conteúdo sobre ${topic}. Nada seria criado ou publicado ainda.`;
  if (normalized === 'es') return `Prepararía un brief de contenido sobre ${topic}. Todavía no se crearía ni publicaría nada.`;
  return `I would prepare a content brief about ${topic}. Nothing would be created or published yet.`;
}

function contentBriefPreviewDiff(payload: Record<string, unknown>, locale: string | null | undefined): Array<{ label: string; before?: string; after: string }> {
  const normalized = normalizeChatCoreV2Locale(locale);
  const labels = normalized === 'pt-BR'
    ? { topic: 'Tema', format: 'Formato', status: 'Estado', preview: 'Prévia' }
    : normalized === 'pt-PT'
      ? { topic: 'Tema', format: 'Formato', status: 'Estado', preview: 'Pré-visualização' }
      : normalized === 'es'
        ? { topic: 'Tema', format: 'Formato', status: 'Estado', preview: 'Vista previa' }
        : { topic: 'Topic', format: 'Format', status: 'Status', preview: 'Preview' };
  return [
    { label: labels.topic, after: contentBriefTopic(payload) },
    { label: labels.format, after: contentBriefFormatLabel(payload, locale) },
    { label: labels.status, after: labels.preview },
  ];
}

function contentBriefTopic(payload: Record<string, unknown>): string {
  const topic = String(payload.topic ?? '').trim();
  return topic || 'Untitled';
}

function contentBriefFormatLabel(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const format = String(payload.format ?? '').trim();
  const normalized = normalizeChatCoreV2Locale(locale);
  if (format === 'reel') return 'Reel';
  if (format === 'short_video') return normalized === 'es' ? 'Video corto' : normalized.startsWith('pt') ? 'Vídeo curto' : 'Short video';
  if (format === 'newsletter') return 'Newsletter';
  if (format === 'youtube') return 'YouTube';
  if (format === 'post') return 'Post';
  return normalized === 'es' ? 'Contenido' : normalized.startsWith('pt') ? 'Conteúdo' : 'Content';
}

function cookingGroceryPreviewTitle(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const normalized = normalizeChatCoreV2Locale(locale);
  const itemLabel = groceryItemLabel(payload, locale);
  if (normalized === 'pt-BR') return `Prévia da lista de compras: ${itemLabel}`;
  if (normalized === 'pt-PT') return `Pré-visualização da lista de compras: ${itemLabel}`;
  if (normalized === 'es') return `Vista previa de compra: ${itemLabel}`;
  return `Grocery preview: ${itemLabel}`;
}

function cookingGroceryPreviewSummary(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const normalized = normalizeChatCoreV2Locale(locale);
  const itemLabel = groceryItemLabel(payload, locale);
  if (normalized === 'pt-BR') return `Eu prepararia ${itemLabel} para a lista de compras. Nada seria adicionado ainda.`;
  if (normalized === 'pt-PT') return `Eu prepararia ${itemLabel} para a lista de compras. Nada seria adicionado ainda.`;
  if (normalized === 'es') return `Prepararía ${itemLabel} para la lista de compras. Todavía no se añadiría nada.`;
  return `I would prepare ${itemLabel} for the grocery list. Nothing would be added yet.`;
}

function cookingGroceryPreviewDiff(payload: Record<string, unknown>, locale: string | null | undefined): Array<{ label: string; before?: string; after: string }> {
  const normalized = normalizeChatCoreV2Locale(locale);
  const items = groceryItemsFromPayload(payload);
  const labels = normalized === 'pt-BR'
    ? { items: 'Itens', list: 'Lista', status: 'Estado', grocery: 'Compras', draft: 'Prévia' }
    : normalized === 'pt-PT'
      ? { items: 'Itens', list: 'Lista', status: 'Estado', grocery: 'Compras', draft: 'Pré-visualização' }
      : normalized === 'es'
        ? { items: 'Artículos', list: 'Lista', status: 'Estado', grocery: 'Compras', draft: 'Vista previa' }
        : { items: 'Items', list: 'List', status: 'Status', grocery: 'Grocery', draft: 'Preview' };
  return [
    { label: labels.items, after: joinGroceryItems(items, locale) },
    { label: labels.list, after: labels.grocery },
    { label: labels.status, after: labels.draft },
  ];
}

function groceryItemsFromPayload(payload: Record<string, unknown>): string[] {
  return Array.isArray(payload.items)
    ? payload.items.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

function groceryItemLabel(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const items = groceryItemsFromPayload(payload);
  return joinGroceryItems(items, locale);
}

function joinGroceryItems(items: string[], locale: string | null | undefined): string {
  const normalized = normalizeChatCoreV2Locale(locale);
  const conjunction = normalized === 'es' ? ' y ' : normalized.startsWith('pt') ? ' e ' : ' and ';
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]}${conjunction}${items[1]}`;
  return `${items.slice(0, -1).join(', ')}${conjunction}${items[items.length - 1]}`;
}

function decisionPreviewTitle(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const title = String(payload.title ?? '').trim();
  const normalized = normalizeChatCoreV2Locale(locale);
  if (normalized === 'pt-BR') return `Prévia para dispensar: ${title}`;
  if (normalized === 'pt-PT') return `Pré-visualização para dispensar: ${title}`;
  if (normalized === 'es') return `Vista previa para descartar: ${title}`;
  return `Dismiss preview: ${title}`;
}

function decisionPreviewSummary(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const title = String(payload.title ?? '').trim();
  const normalized = normalizeChatCoreV2Locale(locale);
  if (normalized === 'pt-BR') return `Eu dispensaria "${title}" do Decision Center. Nada mais mudaria.`;
  if (normalized === 'pt-PT') return `Eu dispensaria "${title}" do Decision Center. Nada mais mudaria.`;
  if (normalized === 'es') return `Descartaría "${title}" del Decision Center. No cambiaría nada más.`;
  return `I would dismiss "${title}" from Decision Center. Nothing else would change.`;
}

function decisionPreviewDiff(payload: Record<string, unknown>, locale: string | null | undefined): Array<{ label: string; before?: string; after: string }> {
  const normalized = normalizeChatCoreV2Locale(locale);
  const labels = normalized === 'pt-BR'
    ? { decision: 'Decisão', status: 'Estado', effect: 'Efeito', active: 'Ativa', dismissed: 'Dispensada', hides: 'Remove da fila ativa' }
    : normalized === 'pt-PT'
      ? { decision: 'Decisão', status: 'Estado', effect: 'Efeito', active: 'Ativa', dismissed: 'Dispensada', hides: 'Remove da fila ativa' }
      : normalized === 'es'
        ? { decision: 'Decisión', status: 'Estado', effect: 'Efecto', active: 'Activa', dismissed: 'Descartada', hides: 'La quita de la cola activa' }
        : { decision: 'Decision', status: 'Status', effect: 'Effect', active: 'Active', dismissed: 'Dismissed', hides: 'Remove from active queue' };
  return [
    { label: labels.decision, after: String(payload.title ?? '').trim() },
    { label: labels.status, before: labels.active, after: labels.dismissed },
    { label: labels.effect, after: labels.hides },
  ];
}

function decisionSnoozePreviewTitle(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const title = String(payload.title ?? '').trim();
  const normalized = normalizeChatCoreV2Locale(locale);
  if (normalized === 'pt-BR') return `Prévia para adiar: ${title}`;
  if (normalized === 'pt-PT') return `Pré-visualização para adiar: ${title}`;
  if (normalized === 'es') return `Vista previa para pausar: ${title}`;
  return `Snooze preview: ${title}`;
}

function decisionSnoozePreviewSummary(payload: Record<string, unknown>, locale: string | null | undefined): string {
  const title = String(payload.title ?? '').trim();
  const normalized = normalizeChatCoreV2Locale(locale);
  const duration = formatSnoozeDuration(Number(payload.snoozeMinutes), normalized);
  if (normalized === 'pt-BR') return `Eu adiaria "${title}" no Decision Center por ${duration}. Nada mais mudaria.`;
  if (normalized === 'pt-PT') return `Eu adiaria "${title}" no Decision Center durante ${duration}. Nada mais mudaria.`;
  if (normalized === 'es') return `Pausaría "${title}" en Decision Center durante ${duration}. No cambiaría nada más.`;
  return `I would snooze "${title}" in Decision Center for ${duration}. Nothing else would change.`;
}

function decisionSnoozePreviewDiff(payload: Record<string, unknown>, locale: string | null | undefined): Array<{ label: string; before?: string; after: string }> {
  const normalized = normalizeChatCoreV2Locale(locale);
  const labels = normalized === 'pt-BR'
    ? { decision: 'Decisão', status: 'Estado', until: 'Até', active: 'Ativa', snoozed: 'Adiada' }
    : normalized === 'pt-PT'
      ? { decision: 'Decisão', status: 'Estado', until: 'Até', active: 'Ativa', snoozed: 'Adiada' }
      : normalized === 'es'
        ? { decision: 'Decisión', status: 'Estado', until: 'Hasta', active: 'Activa', snoozed: 'Pausada' }
        : { decision: 'Decision', status: 'Status', until: 'Until', active: 'Active', snoozed: 'Snoozed' };
  return [
    { label: labels.decision, after: String(payload.title ?? '').trim() },
    { label: labels.status, before: labels.active, after: labels.snoozed },
    { label: labels.until, after: String(payload.snoozedUntil ?? '').trim() },
  ];
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
  const subtasks = taskPreviewSubtasks(payload);
  const duplicateCount = taskPreviewDuplicateCount(payload);
  const normalized = normalizeChatCoreV2Locale(locale);
  if (operation === 'complete') {
    if (duplicateCount > 1) {
      if (normalized === 'pt-BR') return `Eu marcaria ${duplicateCount} tarefas chamadas "${title}" como concluídas.`;
      if (normalized === 'pt-PT') return `Eu marcaria ${duplicateCount} tarefas chamadas "${title}" como concluídas.`;
      if (normalized === 'es') return `Marcaría ${duplicateCount} tareas llamadas "${title}" como completadas.`;
      return `I would mark ${duplicateCount} tasks named "${title}" as done.`;
    }
    if (normalized === 'pt-BR') return `Eu marcaria "${title}" como concluída.`;
    if (normalized === 'pt-PT') return `Eu marcaria "${title}" como concluída.`;
    if (normalized === 'es') return `Marcaría "${title}" como completada.`;
    return `I would mark "${title}" as done.`;
  }
  if (normalized === 'pt-BR') {
    if (subtasks.length > 0) return `Revê e confirma para criar a tarefa "${title}" com ${subtasks.length} subtarefa(s).`;
  }
  if (normalized === 'pt-PT') {
    if (subtasks.length > 0) return `Revê e confirma para criar a tarefa "${title}" com ${subtasks.length} subtarefa(s).`;
  }
  if (normalized === 'es') {
    if (subtasks.length > 0) return `Revisa y confirma para crear la tarea "${title}" con ${subtasks.length} subtarea(s).`;
  }
  if (subtasks.length > 0) return `Review and confirm to create the task "${title}" with ${subtasks.length} subtask(s).`;
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
    ? { task: 'Tarefa', subtasks: 'Subtarefas', due: 'Quando', status: 'Estado', pending: 'Pendente', completed: 'Concluída', count: 'Quantidade' }
    : normalized === 'pt-PT'
      ? { task: 'Tarefa', subtasks: 'Subtarefas', due: 'Quando', status: 'Estado', pending: 'Pendente', completed: 'Concluída', count: 'Quantidade' }
      : normalized === 'es'
        ? { task: 'Tarea', subtasks: 'Subtareas', due: 'Cuándo', status: 'Estado', pending: 'Pendiente', completed: 'Completada', count: 'Cantidad' }
        : { task: 'Task', subtasks: 'Subtasks', due: 'When', status: 'Status', pending: 'Pending', completed: 'Done', count: 'Count' };
  const title = String(payload.title ?? '').trim();
  const due = typeof payload.dueDateTime === 'string' && payload.dueDateTime.trim()
    ? payload.dueDateTime.trim()
    : null;
  const subtasks = taskPreviewSubtasks(payload);
  const duplicateCount = taskPreviewDuplicateCount(payload);
  if (operation === 'complete') {
    return [
      { label: labels.task, after: title },
      ...(duplicateCount > 1 ? [{ label: labels.count, after: String(duplicateCount) }] : []),
      { label: labels.status, after: labels.completed },
    ];
  }
  return [
    { label: labels.task, after: title },
    ...(subtasks.length > 0 ? [{ label: labels.subtasks, after: subtasks.join(', ') }] : []),
    ...(due ? [{ label: labels.due, after: due }] : []),
  ];
}

function taskPreviewSubtasks(payload: Record<string, unknown>): string[] {
  return Array.isArray(payload.subtasks)
    ? payload.subtasks.map((subtask) => String(subtask).trim()).filter(Boolean)
    : [];
}

function taskPreviewDuplicateCount(payload: Record<string, unknown>): number {
  return Array.isArray(payload.duplicateTasks) ? payload.duplicateTasks.length : 0;
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
    entityVersion: notificationSnoozeVersionForItem(item),
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

function extractDecisionDismissReference(text: string): string | null {
  const patterns = [
    new RegExp(String.raw`\b(?:dismiss|close|ignore|drop)\s+(?:the\s+|my\s+)?(.+?)\s+${DECISION_NOUN_SOURCE}\b`, 'i'),
    new RegExp(String.raw`\b(?:dismiss|close|ignore|drop)\s+(?:the\s+|my\s+)?${DECISION_NOUN_SOURCE}\s+(?:about|for|called|named)?\s*(.+?)(?=$|[.!?])`, 'i'),
    new RegExp(String.raw`\b(?:dispensar|dispensa|descartar|descarta|descarte|ignorar|ignora|fechar|fecha|feche)\s+(?:a\s+|la\s+|essa\s+|esta\s+)?(.+?)\s+${DECISION_NOUN_SOURCE}\b`, 'i'),
    new RegExp(String.raw`\b(?:dispensar|dispensa|descartar|descarta|descarte|ignorar|ignora|fechar|fecha|feche)\s+(?:a\s+|la\s+|essa\s+|esta\s+)?${DECISION_NOUN_SOURCE}\s+(?:sobre|chamada?|llamada?|llamado|called|named)?\s*(.+?)(?=$|[.!?])`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const reference = cleanupDecisionReference(match?.[1]);
    if (reference) return reference;
  }
  return null;
}

function extractDecisionSnoozeRequest(text: string): { referencePhrase: string | null; snoozeMinutes: number } {
  const snoozeMinutes = normalizeSnoozeMinutes(extractSnoozeMinutes(text));
  const withoutDuration = text
    .replace(/\b(?:for|durante|por|until|ate|até|hasta)\s+.+$/i, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const patterns = [
    new RegExp(String.raw`\b(?:snooze|postpone|pause)\s+(?:the\s+|my\s+)?(.+?)\s+${DECISION_NOUN_SOURCE}\b`, 'i'),
    new RegExp(String.raw`\b(?:snooze|postpone|pause)\s+(?:the\s+|my\s+)?${DECISION_NOUN_SOURCE}\s+(?:about|for|called|named)?\s*(.+?)(?=$|[.!?])`, 'i'),
    new RegExp(String.raw`\b(?:adiar|adia|adie|pausar|pausa|pause|posponer|posp[oó]n|postergar)\s+(?:a\s+|la\s+|essa\s+|esta\s+)?(.+?)\s+${DECISION_NOUN_SOURCE}\b`, 'i'),
    new RegExp(String.raw`\b(?:adiar|adia|adie|pausar|pausa|pause|posponer|posp[oó]n|postergar)\s+(?:a\s+|la\s+|essa\s+|esta\s+)?${DECISION_NOUN_SOURCE}\s+(?:sobre|chamada?|llamada?|llamado|called|named)?\s*(.+?)(?=$|[.!?])`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(withoutDuration);
    const reference = cleanupDecisionReference(match?.[1]);
    if (reference) return { referencePhrase: reference, snoozeMinutes };
  }
  return { referencePhrase: null, snoozeMinutes };
}

function normalizeSnoozeMinutes(minutes: number): number {
  return Number.isFinite(minutes) && minutes > 0 ? Math.min(Math.round(minutes), 24 * 60) : NOTIFICATION_SNOOZE_DEFAULT_MINUTES;
}

function cleanupDecisionReference(value: unknown): string | null {
  const cleaned = String(value ?? '')
    .replace(/^["“]|["”]$/g, '')
    .replace(DECISION_NOUN_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!cleaned || /^(?:this|that|it|essa|esta|isso|the|my|a|o|la)$/i.test(cleaned)) return null;
  return cleaned;
}

function decisionToResolutionCandidate(
  item: DecisionApiItem,
  referencePhrase: string,
  action: 'dismiss' | 'snooze' = 'dismiss',
): EntityResolutionCandidate {
  const confidence = scoreDecisionCandidate(referencePhrase, item);
  return {
    id: `decision:${item.decisionId}`,
    label: item.title,
    confidence,
    reason: confidence >= 0.95
      ? 'title_exact_match'
      : confidence >= 0.84
        ? 'decision_text_match'
        : 'title_partial_match',
    entityVersion: action === 'snooze' ? decisionSnoozeVersionForItem(item) : decisionDismissVersionForItem(item),
    domain: 'decision_center',
    metadata: {
      decisionId: item.decisionId,
      status: item.status,
      sourceSkill: item.sourceSkill,
    },
  };
}

function scoreDecisionCandidate(referencePhrase: string, item: DecisionApiItem): number {
  const reference = normalizeDecisionResolutionText(referencePhrase);
  const decisionId = normalizeDecisionResolutionText(item.decisionId);
  const itemId = normalizeDecisionResolutionText(item.itemId);
  const title = normalizeDecisionResolutionText(item.title);
  const body = normalizeDecisionResolutionText([
    item.summary,
    item.safePreviewBody,
    item.problemStatement,
    item.recommendation,
    item.explanation?.headline,
    item.explanation?.whatHappened,
    item.explanation?.userAction,
    item.explanation?.recommendedMove,
  ].filter(Boolean).join(' '));
  if (!reference || !title) return 0;
  if (reference === decisionId || reference === itemId) return 0.99;
  if (reference === title) return 0.97;
  if (title.includes(reference)) return 0.9;
  if (reference.includes(title)) return 0.88;
  if (body.includes(reference)) return 0.84;

  const referenceTokens = new Set(reference.split(' ').filter((token) => token.length > 1));
  const decisionTokens = new Set(`${title} ${body}`.split(' ').filter((token) => token.length > 1));
  if (referenceTokens.size === 0 || decisionTokens.size === 0) return 0;
  const overlap = [...referenceTokens].filter((token) => decisionTokens.has(token)).length;
  if (overlap === 0) return 0;
  const ratio = overlap / Math.max(referenceTokens.size, decisionTokens.size);
  return Math.min(0.86, 0.55 + ratio * 0.35);
}

function normalizeDecisionResolutionText(value: string): string {
  return foldCalendarText(value)
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decisionIdFromCandidate(candidate: EntityResolutionCandidate): string | null {
  const fromMetadata = candidate.metadata?.decisionId;
  if (typeof fromMetadata === 'string' && fromMetadata.trim()) return fromMetadata;
  const match = /^decision:(.+)$/.exec(candidate.id);
  return match?.[1] ?? null;
}

function extractTrainingChangeTypes(text: string): TrainingChangeType[] {
  const normalized = foldCalendarText(text).toLowerCase();
  const wantsLighter = /\b(lighter|easier|easy|reduce|reduced|less\s+intense|lower\s+intensity|mais\s+leve|leve|reduz(?:ir|e|a)?|suave|menos\s+intens[ao]|mas\s+suave|más\s+suave|bajar\s+intensidad)\b/i.test(normalized);
  const asksToMoveOnly = /\b(move|reschedule|mover|remarcar|reagendar|cambiar|mudar)\b/i.test(normalized) && !wantsLighter;
  if (!wantsLighter || asksToMoveOnly) return [];
  return ['reduce_intensity'];
}

function resolveTrainingSessionTarget(
  input: BuildChatCoreV2CommandPreviewRouteInput,
  now: Date,
): TrainingSessionPreviewTarget | null {
  const reference = parseTrainingSessionReference(input.normalizedText, now, input.timezone);
  if (!reference) return null;

  const plan = getActivePlan(input.userId, input.tenantId);
  if (!plan) return null;

  const weeks = getWeeksForPlan(plan.id);
  if (weeks.length === 0) return null;

  const todayKey = dateKey(now, normalizeTimezone(input.timezone));
  const candidates = weeks
    .flatMap((week) =>
      getSessionsForWeek(week.id)
        .filter(isActiveTrainingSession)
        .map((session) => {
          const sessionDate = trainingSessionDateForWeek(plan, week, session.day_of_week);
          return { week, session, sessionDate };
        }))
    .filter((candidate) => candidate.sessionDate === null || candidate.sessionDate >= todayKey)
    .sort((a, b) => String(a.sessionDate ?? '').localeCompare(String(b.sessionDate ?? '')));

  const selected = selectTrainingSessionCandidate(candidates, reference);
  if (!selected) return null;

  return {
    plan,
    week: selected.week,
    session: selected.session,
    sessionDate: selected.sessionDate,
    sessionDateLabel: formatTrainingSessionTargetDate(selected.sessionDate, selected.session.day_of_week, input.locale),
    entityVersions: trainingEntityVersions(plan, selected.week, selected.session),
  };
}

type TrainingSessionReference =
  | { kind: 'exact_date'; date: string }
  | { kind: 'day_of_week'; dayIndex: number }
  | { kind: 'next_session' };

function parseTrainingSessionReference(
  text: string,
  now: Date,
  timezone: string,
): TrainingSessionReference | null {
  const normalized = foldCalendarText(text).toLowerCase();
  const today = dateKey(now, normalizeTimezone(timezone));
  if (/\b(today|hoje|hoy)\b/i.test(normalized)) return { kind: 'exact_date', date: today };
  if (/\b(tomorrow|amanha|mañana|manana)\b/i.test(normalized)) return { kind: 'exact_date', date: addDays(today, 1) };
  if (/\b(next\s+(?:training\s+)?session|next\s+workout|proximo\s+treino|proxima\s+sessao|pr[oó]ximo\s+treino|pr[oó]xima\s+sess[aã]o|siguiente\s+(?:sesion|entrenamiento)|pr[oó]xima\s+(?:sesion|entrenamiento))\b/i.test(normalized)) {
    return { kind: 'next_session' };
  }
  const dayIndex = dayIndexFromText(normalized);
  if (dayIndex !== null) return { kind: 'day_of_week', dayIndex };
  return null;
}

function selectTrainingSessionCandidate(
  candidates: Array<{ week: TrainingWeek; session: TrainingSession; sessionDate: string | null }>,
  reference: TrainingSessionReference,
): { week: TrainingWeek; session: TrainingSession; sessionDate: string | null } | null {
  if (reference.kind === 'next_session') return candidates[0] ?? null;
  if (reference.kind === 'exact_date') return candidates.find((candidate) => candidate.sessionDate === reference.date) ?? null;
  return candidates.find((candidate) => dayIndexForTrainingDay(candidate.session.day_of_week) === reference.dayIndex) ?? null;
}

function isActiveTrainingSession(session: TrainingSession): boolean {
  return ACTIVE_TRAINING_SESSION_STATUSES.has(normalizeTrainingStatus(session.status));
}

function trainingEntityVersions(
  plan: TrainingPlan,
  week: TrainingWeek,
  session: TrainingSession,
): Record<string, string> {
  return {
    [`training_plan:${plan.id}`]: hashStable({
      name: plan.name,
      sport: plan.sport,
      goal: plan.goal,
      durationWeeks: plan.duration_weeks,
      status: plan.status,
      startDate: plan.start_date,
      endDate: plan.end_date,
      planVersion: plan.plan_version,
      updatedAt: plan.updated_at,
      weekNumber: week.week_number,
      weekFocus: week.focus,
      weekIntensityPct: week.intensity_pct,
    }),
    [`training_session:${session.id}`]: hashStable({
      title: session.title,
      dayOfWeek: session.day_of_week,
      sessionType: session.session_type,
      durationMinutes: session.duration_minutes,
      intensityText: session.intensity_text,
      status: session.status,
      sessionIdentityKey: session.session_identity_key,
      sessionShapeHash: session.session_shape_hash,
      updatedAt: session.updated_at,
    }),
  };
}

function trainingSessionDateForWeek(
  plan: TrainingPlan,
  week: TrainingWeek,
  dayOfWeek: string,
): string | null {
  const dayIndex = dayIndexForTrainingDay(dayOfWeek);
  if (dayIndex === null) return null;
  const planStart = parseDateKey(plan.start_date);
  if (!planStart) return null;
  const planMonday = addDaysToDate(planStart, -mondayOffset(planStart));
  const weekMonday = addDaysToDate(planMonday, (Math.max(1, week.week_number) - 1) * 7);
  return dateKeyFromDate(addDaysToDate(weekMonday, dayIndex));
}

function formatTrainingSessionTargetDate(
  date: string | null,
  dayOfWeek: string,
  locale: string | null | undefined,
): string {
  const normalized = normalizeChatCoreV2Locale(locale);
  if (!date) return localizedTrainingDay(dayOfWeek, normalized);
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return date;
  const localeTag = normalized === 'pt-BR'
    ? 'pt-BR'
    : normalized === 'pt-PT'
      ? 'pt-PT'
      : normalized === 'es'
        ? 'es-ES'
        : 'en-GB';
  try {
    return new Intl.DateTimeFormat(localeTag, {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
    }).format(parsed);
  } catch {
    return date;
  }
}

function localizedTrainingDay(dayOfWeek: string, locale: ReturnType<typeof normalizeChatCoreV2Locale>): string {
  const dayIndex = dayIndexForTrainingDay(dayOfWeek);
  const english = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const pt = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
  const es = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  if (dayIndex === null) return dayOfWeek;
  if (locale === 'es') return es[dayIndex];
  if (locale === 'pt-BR' || locale === 'pt-PT') return pt[dayIndex];
  return english[dayIndex];
}

function dayIndexFromText(text: string): number | null {
  const normalized = foldCalendarText(text).toLowerCase();
  const patterns: Array<[number, RegExp]> = [
    [0, /\b(monday|segunda|lunes)\b/i],
    [1, /\b(tuesday|terca|terça|martes)\b/i],
    [2, /\b(wednesday|quarta|miercoles|miércoles)\b/i],
    [3, /\b(thursday|quinta|jueves)\b/i],
    [4, /\b(friday|sexta|viernes)\b/i],
    [5, /\b(saturday|sabado|sábado)\b/i],
    [6, /\b(sunday|domingo)\b/i],
  ];
  return patterns.find(([, pattern]) => pattern.test(normalized))?.[0] ?? null;
}

function dayIndexForTrainingDay(dayOfWeek: string): number | null {
  return dayIndexFromText(dayOfWeek);
}

function parseDateKey(value: string): Date | null {
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function dateKeyFromDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDaysToDate(value: Date, days: number): Date {
  const next = new Date(value.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function mondayOffset(value: Date): number {
  return (value.getUTCDay() + 6) % 7;
}

function normalizeTrainingStatus(value: unknown): string {
  return String(value ?? 'pending').trim().toLowerCase();
}

interface ContentBriefDraft {
  topic: string;
  objective: string;
  format: 'content' | 'post' | 'reel' | 'short_video' | 'newsletter' | 'youtube';
}

function extractContentBriefDraft(text: string): ContentBriefDraft | null {
  const patterns = [
    /\b(?:create|draft|write|prepare)\s+(?:a\s+)?(?:content\s+)?brief(?:ing)?(?:\s+draft)?\s+(?:for|about|on)\s+(.+?)(?=$|[.!?])/i,
    /\b(?:create|draft|write|prepare)\s+(?:a\s+)?brief(?:ing)?\s+(?:for|about|on)\s+(?:a\s+)?(?:content\s+|post\s+|script\s+|reel\s+|video\s+|newsletter\s+)?(.+?)(?=$|[.!?])/i,
    /\b(?:criar|cria|preparar|prepara|escrever|escreve)\s+(?:um\s+|uma\s+)?brief(?:ing)?\s+de\s+conte[uú]do\s+(?:para|sobre|acerca\s+de)\s+(.+?)(?=$|[.!?])/i,
    /\b(?:crear|preparar|escribir|redactar)\s+(?:un\s+|una\s+)?brief(?:ing)?\s+de\s+contenido\s+(?:para|sobre|acerca\s+de)\s+(.+?)(?=$|[.!?])/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const topic = cleanupContentBriefTopic(match?.[1]);
    if (topic) {
      return {
        topic,
        objective: `Prepare a content brief about ${topic}.`,
        format: inferContentBriefFormat(text),
      };
    }
  }
  return null;
}

function cleanupContentBriefTopic(value: unknown): string | null {
  const cleaned = String(value ?? '')
    .replace(/^["“]|["”]$/g, '')
    .replace(/\b(?:content\s+)?brief(?:ing)?(?:\s+draft)?\b/gi, ' ')
    .replace(/\b(?:conte[uú]do|contenido)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!cleaned || /^(?:it|this|that|algo|isso|isto|eso|aquilo|something|content)$/i.test(cleaned)) return null;
  return cleaned.slice(0, 160);
}

function inferContentBriefFormat(text: string): ContentBriefDraft['format'] {
  if (/\b(reel|shorts?|short\s+video|vídeo\s+curto|video\s+corto)\b/i.test(text)) return 'short_video';
  if (/\bnewsletter\b/i.test(text)) return 'newsletter';
  if (/\b(youtube|yt)\b/i.test(text)) return 'youtube';
  if (/\b(post|publica[cç][aã]o|publicaci[oó]n)\b/i.test(text)) return 'post';
  return 'content';
}

function extractCookingGroceryItems(text: string): string[] {
  const patterns = [
    /\b(?:add|buy|get)\s+(.+?)\s+(?:to|for|on|in)\s+(?:my\s+)?(?:grocery|groceries|shopping)(?:\s+list)?\b/i,
    /\b(?:create|make|prepare)\s+(?:a\s+)?(?:grocery|shopping)(?:\s+list)?\s+(?:with|for|of)\s+(.+?)(?=$|[.!?])/i,
    /\b(?:adicionar|adiciona|acrescentar|acrescenta|comprar|compra)\s+(.+?)\s+(?:a|à|ao|na|para a)\s+(?:minha\s+)?lista\s+de\s+compras\b/i,
    /\b(?:criar|cria|preparar|prepara)\s+(?:uma\s+)?lista\s+de\s+compras\s+(?:com|para|de)\s+(.+?)(?=$|[.!?])/i,
    /\b(?:agregar|añadir|anadir|comprar)\s+(.+?)\s+(?:a|en|para)\s+(?:mi\s+)?lista\s+de\s+(?:compras|la\s+compra)\b/i,
    /\b(?:crear|preparar)\s+(?:una\s+)?lista\s+de\s+(?:compras|la\s+compra)\s+(?:con|para|de)\s+(.+?)(?=$|[.!?])/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const items = splitCookingGroceryItems(match?.[1]);
    if (items.length > 0) return items;
  }
  return [];
}

function splitCookingGroceryItems(value: unknown): string[] {
  const cleaned = String(value ?? '')
    .replace(/^["“]|["”]$/g, '')
    .replace(/\b(?:some|items?|ingredients?|grocer(?:y|ies)|shopping|lista\s+de\s+compras|lista\s+de\s+la\s+compra|compras)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(/\s*(?:,|;|\band\b|\be\b|\by\b|\+)\s*/i)
    .map((item) => item.replace(/^(?:and|e|y)\s+/i, '').trim())
    .map((item) => item.replace(/\s{2,}/g, ' '))
    .filter((item) => item.length > 1)
    .slice(0, 10);
}

function dateKey(now: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const part = (type: string) => parts.find((item) => item.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    return year && month && day ? `${year}-${month}-${day}` : now.toISOString().slice(0, 10);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function weekStartForDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return date;
  const utcDay = parsed.getUTCDay();
  const mondayOffset = ((utcDay + 6) % 7);
  return addDays(date, -mondayOffset);
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return date;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
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

function listNativeTasksForPreview(userId: number): ChatCoreV2ResolvableTask[] {
  try {
    const rows = getDb().prepare(`
      SELECT t.*, l.name AS list_name
      FROM native_tasks t
      JOIN native_task_lists l ON l.id = t.list_id
      WHERE t.user_id = ?
        AND t.status != 'completed'
      ORDER BY t.position ASC, t.created_at DESC
      LIMIT 100
    `).all(userId) as Array<{
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
    }>;

    return rows.map((row) => ({
      id: Number(row.id),
      provider: 'nexus',
      externalId: String(row.id),
      projectId: Number(row.list_id),
      projectName: row.list_name,
      title: row.title,
      description: row.body ?? undefined,
      status: row.status === 'inProgress' ? 'in_progress' : 'pending',
      priority: nativeImportanceToPriority(row.importance),
      dueDate: row.due_date_time ?? undefined,
      dueIsDatetime: !!row.due_date_time?.includes('T'),
      tags: parseNativeTags(row.tags),
      notes: row.body ?? undefined,
      completedAt: row.completed_at ?? undefined,
      providerData: {
        chatCoreV2TaskStore: 'native_tasks',
        nativeListId: Number(row.list_id),
      },
    }));
  } catch {
    return [];
  }
}

function nativeImportanceToPriority(importance: string | null): number {
  if (importance === 'high') return 3;
  if (importance === 'normal') return 2;
  return 1;
}

function parseNativeTags(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : undefined;
  } catch {
    return undefined;
  }
}

function taskToResolutionCandidate(task: ChatCoreV2ResolvableTask, referencePhrase: string): EntityResolutionCandidate {
  const confidence = scoreTaskCandidate(referencePhrase, task.title);
  const taskStore = task.providerData?.chatCoreV2TaskStore === 'native_tasks' ? 'native_tasks' : 'unified_tasks';
  return {
    id: taskStore === 'native_tasks' ? `native_task:${task.id}` : `task:${task.id}`,
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
      taskStore,
      nativeListId: task.providerData?.nativeListId ?? null,
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
  const match = /^(?:task|native_task):(\d+)$/.exec(candidate.id);
  return match ? Number(match[1]) : null;
}
