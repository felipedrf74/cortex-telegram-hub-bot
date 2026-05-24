// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';
import {
  createEvent,
  getEventsForSources,
  updateEvent,
  deleteEvent,
  type CalendarSource,
  type UnifiedCalendarEvent,
} from '../unified-calendar';
import { isGoogleCalendarConfigured } from '../google-calendar';
import { isOutlookCalendarConfigured } from '../outlook-calendar';
import {
  parseNaturalLanguageCalendarEvent,
  hasCalendarWriteIntent,
  hasCalendarReadIntent,
  hasMailReadIntent,
  foldCalendarText,
} from '../calendar-natural-language-parser';
import {
  findChatActionDefinition,
  messageHasActionCandidate,
  riskClassForRisk,
  selectRegistrySubsetForMessage,
  type ChatActionDefinition,
} from './registry';
import type {
  CalendarProviderDeps,
  ChatActionExecutionOptions,
  ChatActionPlan,
  ChatActionPlannerDeps,
  ChatActionRouteResponse,
  ChatActionStatus,
  ChatClarificationReason,
  ChatPlannerInput,
  ChatPlanStep,
  ChatStepExecutionResult,
} from './types';
import {
  buildNormalizedActionHash,
  claimChatActionRunForExecution,
  listPendingChatActionRuns,
  type ChatActionRunStatus,
} from '../chat-action-run-store';
import {
  cancelPendingChatActions,
  makeSlotProvenance,
  recordChatActionTelemetry,
  rememberRecentChatEntity,
  resolveRecentChatEntity,
} from '../chat-action-state';
import { getChatStepExecutor } from './executor/dispatch-table';
import {
  buildLlmPlannerPrompt,
  buildTier1ClassifierPrompt,
  parseLlmPlannerJson,
  parseTier1ClassifierJson,
  tryBuildEscalationReviewerPlan,
  tryBuildLlmStructuredPlan,
  tryBuildTier1ClassifierPlan,
} from './planner/tiers';
import { sanitizePlannerArgs } from './planner/arg-sanitizer';
import {
  getCurrentChatToolAuthorizationContext,
  runWithChatToolAuthorization,
} from '../chat-tool-authorization';
import {
  buildStepIdempotencyKey,
  makeStep,
} from '../skills/step-builder';
import { parseContentActionStep } from '../skills/content/parser';
import { buildPendingContentSpecContinuation } from '../skills/content/pending';
import { buildPendingCookingMealPlanContinuation } from '../skills/cooking/pending';
import { buildPendingDecisionChooseContinuation } from '../skills/decision_center/pending';
import { buildPendingFinanceCategorizeContinuation } from '../skills/finance/pending';
import { buildPendingMailDraftContinuation } from '../skills/mail/pending';
import { hasPastTenseSignal } from '../skills/past-tense-detector';
import { extractTopic, inferContentPlatform, inferProviderName } from '../skills/text-extractors';
import { buildPendingSlotContinuationPlan } from '../skills/training/pending';
import type { PendingContinuationHelpers } from './planner/pending-types';
import { invalidateCalendarCaches } from '../cache-coherence-registry';
import { getTaskProviderForUser } from '../task-store/task-router';
import { resolveTaskCreationList } from '../task-store/task-list-resolution';
import {
  buildContentAgencyPackage,
  getContentAgencyProject,
  handoffContentAgencyPackageToPipeline,
  persistContentAgencyArtifact,
} from '../content-agency';
import { addTopic, getTopicById } from '../content-scheduler';
import { generateShoppingList, getMealPlan, getShoppingList, setMealPlan } from '../cooking-chef';
import {
  getMonthlySummary,
  getPreferredCurrencyForUser,
  getTaxEvents,
  markTaxPaid,
  updateTransactionCategory,
} from '../finance-tracker';
import { getIntegrationSummary } from '../integration-status';
import { getActivePlanSummary, getPlanById, getSessionById } from '../training-plans';
import {
  confirmTrainingSessionReflow,
  previewTrainingSessionReflow,
} from '../../api/routes/training-plan-calendar-sync';
import { getUnreadMailSummaryForUser } from '../unified-mail-pressure';
import { searchEmailsForUser as searchGmailEmailsForUser } from '../google-gmail';
import { searchEmailsForUser as searchOutlookEmailsForUser } from '../outlook-mail';
import {
  createNotificationIntent,
  getOrCreateNotificationProfile,
  updateNotificationProfile,
} from '../notification-orchestrator';
import {
  dismissDecision,
  getDecisionItem,
  performDecisionAction,
  snoozeDecision,
} from '../decision-center';
import { logger } from '../../utils/logger';
import {
  getChatHybridPlannerMode,
} from '../runtime-flags';
import { splitChatMultiStepRequest } from '../chat-multi-step-splitter';
import { routeChatMultiStepSegments } from '../chat-segment-router';
import { resolveStepRefs } from '../chat-multi-step-dag';
import { enqueueChatActionFixerReview } from '../chat-action-fixer-worker';
import {
  normalizeChatActionErrorReason,
  runChatActionWithBoundedRetry,
  shouldQueueChatActionFixerReview,
} from '../chat-action-retry-policy';
import type { ChatStepExecutionContext } from './executor/types';
import {
  actionButtonsForResults,
  calendarCardEvents,
  firstTitle,
  openSurfacePayloadForStep,
  resultCardPayload,
  sanitizeActionResults,
} from './executor/response-cards';
import {
  buildActionResponse,
  multiStepMetadata,
  multiStepType,
} from './executor/response-builder';
import {
  confirmationCopy,
  failureCopy,
  partialCopy,
  refusalCopyForReason,
  refusalReasonForPlan,
  successCopy,
  unsupportedChatExecutorReason,
  verifiedPendingCopy,
} from './executor/response-copy';
import {
  confirmationVariant,
  intentClassForPlan,
  normalizeProvider,
  stepRequiresConfirmation,
} from './planner/plan-utils';
import {
  persistPlanStatus,
  persistStepStatus,
  requeuePartialSuccessPendingParents,
  rowToConfirmedStep,
} from './executor/run-persistence';
import {
  buildClarificationPlan,
  buildMessageOnlyPlan,
  buildNeedsInputPlan,
  buildPlanFromSteps,
  clarificationReasonForPlan,
} from './planner/plan-builder';
import {
  buildIncompleteCalendarCreatePlan,
  parseBulkDestructiveRefusal,
  parsePromptInjectionRefusal,
  parseSensitiveDataExfiltrationRefusal,
} from './planner/safety-refusals';
import {
  buildCalendarSlotProvenance,
  parseCalendarMutationIntent,
  parseCheckCalendarConflictsIntent,
  parseSummarizeAgendaIntent,
} from './planner/calendar-intents';
import {
  parseCompleteTaskByMarkIntent,
  parseTaskMutationIntent,
} from './planner/task-mutations';
import {
  extractTaskClause,
  parseSimpleTaskIntent,
  parseSimpleTaskStep,
  startsWithSimpleTaskCreateIntent,
} from './planner/simple-task';
import {
  hasLegacySubtaskIntent,
  parseCreateChecklistIntent,
  parseTaskWithSubtasksIntent,
  startsWithTaskWithSubtasksIntent,
} from './planner/task-subtasks';
import {
  buildTargetedClarificationQuestion,
  defaultClarification,
} from './planner/clarification';
import { parseBroadSkillActionIntent } from './planner/broad-skill-intents';
import {
  recordShadowTelemetry,
  summarizeSlotProvenance,
  thresholdForSteps,
} from './executor/telemetry';

export { buildLlmPlannerPrompt, buildTier1ClassifierPrompt, parseLlmPlannerJson, parseTier1ClassifierJson } from './planner/tiers';
export { BROAD_SKILL_MIN_PRIORITY_GAP, BROAD_SKILL_SLOT_COMPLETENESS_BONUS } from './planner/broad-skill-intents';

export type {
  CalendarProviderDeps,
  ChatActionExecutionOptions,
  ChatActionPlan,
  ChatActionPlannerDeps,
  ChatActionRouteResponse,
  ChatActionStatus,
  ChatClarificationReason,
  ChatPlannerInput,
  ChatPlanStep,
  ChatPlanStepType,
  ChatStepExecutionResult,
} from './types';

const DEFAULT_PROVIDER_READ_BACK_TIMEOUT_MS = 3_500;
const DEFAULT_PROVIDER_WRITE_TIMEOUT_MS = 10_000;

const DEFAULT_DEPS: Required<ChatActionPlannerDeps> = {
  calendar: {
    createEvent,
    getEventsForSources,
    hasGoogle: isGoogleCalendarConfigured,
    hasOutlook: isOutlookCalendarConfigured,
  },
  taskProviderForUser: getTaskProviderForUser,
};

const PENDING_CONTINUATION_HELPERS: PendingContinuationHelpers = {
  buildPlanFromSteps,
  buildNeedsInputPlan,
  buildTargetedClarificationQuestion,
};

function hasSimpleTaskWriteIntent(text: string): boolean {
  const folded = foldCalendarText(text);
  return !hasLegacySubtaskIntent(text)
    // Phase 2 batch 10: PT-BR "bota" (colloquial) and "coloca" (BR + PT)
    // join the create-verb set so "Bota uma tarefa..." routes correctly.
    // Phase 8 batch 43 (2026-05-15): Spanish "crea"/"crear" added.
    && /\b(cria|criar|adiciona|adicionar|create|add|bota[r]?|coloca[r]?|p[oõ]e[r]?|mete[r]?|crea[r]?)\b/.test(folded)
    && /\b(task|tarefa|todo|lembrete|tarea[s]?)\b/.test(folded);
}

export function shouldRunActionPlannerBeforeReadOnlyFastPaths(text: string): boolean {
  if (!text.trim()) return false;
  if (hasLegacySubtaskIntent(text)) return true;
  if (hasCalendarWriteIntent(text)) return true;
  // Calendar read intent (e.g., "What's on my agenda today", "Mostra a agenda
  // de domingo", "agenda do Gmail") routes to summarize_agenda via the new
  // parseSummarizeAgendaIntent path; let the planner run.
  if (hasCalendarReadIntent(text)) return true;
  if (hasSimpleTaskWriteIntent(text)) return true;
  const folded = foldCalendarText(text);
  if (hasMailReadIntent(text) && !messageHasActionCandidate(text)) return false;
  return messageHasActionCandidate(text) && (
    /\b(send|enviar|draft|reply|responder|publish|publicar|delete|apaga|apagar|cancel|cancelar|remove|remover|paga|pay|stripe|refund|reembolso|admin|security|seguranca|revoga|revogar|revoke|reconnect)\b/.test(folded)
    || /\b(script|roteiro|brief|conteudo|content|meal|refeicao|jantar|almoco|ceia|lanche|compras|grocery|fueling|finance|financeiro|financeira|orcamento|budget|receipt|categorize|conexao|connection|sync|notificacao|notificacoes|notification|decision|decisao|treino|training)\b/.test(folded)
  );
}

export async function tryHandleChatActionPlan(
  input: ChatPlannerInput,
  deps: ChatActionPlannerDeps = {},
): Promise<{ plan: ChatActionPlan; response: ChatActionRouteResponse; status: ChatActionStatus } | null> {
  const routeStartedAtMs = Date.now();
  const plannerMode = getChatHybridPlannerMode(process.env, { userId: input.userId, tenantId: input.tenantId });
  if (plannerMode === 'off') return null;
  const plan = await buildChatActionPlan({ ...input, routeStartedAtMs });
  if (!plan) return null;
  if (plannerMode === 'shadow') {
    logger.info({
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      planner: plan.planner,
      actions: plan.steps.map((step) => ({ skill: step.skill, action: step.action, riskClass: step.riskClass })),
      effectiveConfidence: plan.effectiveConfidence ?? plan.confidence,
      routeTier: plan.telemetry?.routeTier,
      threshold: plan.telemetry?.threshold,
    }, 'chat hybrid planner shadow candidate');
    recordShadowTelemetry(plan, input, routeStartedAtMs);
    return null;
  }
  const resolvedDeps = { ...DEFAULT_DEPS, ...deps };
  const response = await executeChatActionPlan(plan, { ...input, routeStartedAtMs }, resolvedDeps);
  return { plan, response, status: String(response.metadata.actionStatus || 'planned') as ChatActionStatus };
}

export async function executeConfirmedChatActionRuns(
  input: ChatPlannerInput & { sourceMessageId?: string | null },
  deps: ChatActionPlannerDeps = {},
): Promise<{ plan: ChatActionPlan; response: ChatActionRouteResponse; status: ChatActionStatus } | null> {
  const rows = listPendingChatActionRuns({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.sourceMessageId ? null : input.conversationId,
    messageId: input.sourceMessageId ?? null,
    limit: 10,
  });
  if (rows.length === 0) return null;
  const steps = rows.map(rowToConfirmedStep).filter((step): step is ChatPlanStep => Boolean(step));
  if (steps.length === 0) return null;
  const plan: ChatActionPlan = {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: rows[0]?.conversation_id ?? input.conversationId,
    messageId: rows[0]?.message_id ?? input.messageId,
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: new Date().toISOString(),
    planner: 'mixed',
    steps,
    requiresConfirmation: false,
    confidence: 0.93,
  };
  const resolvedDeps = { ...DEFAULT_DEPS, ...deps };
  const response = await executeChatActionPlan(plan, {
    ...input,
    conversationId: plan.conversationId,
    messageId: plan.messageId,
  }, resolvedDeps, { confirmed: true });
  return { plan, response, status: String(response.metadata.actionStatus || 'planned') as ChatActionStatus };
}

export async function buildChatActionPlan(input: ChatPlannerInput): Promise<ChatActionPlan | null> {
  const cancellation = buildPendingCancellationPlan(input);
  if (cancellation) return cancellation;

  const pendingContinuation = buildPendingSlotContinuationPlan(input, PENDING_CONTINUATION_HELPERS);
  if (pendingContinuation) return pendingContinuation;
  // Phase 7 close-out (2026-05-15): cooking pending-meal-plan continuation.
  // Mirrors the training-plan continuation: when the user has a pending
  // cooking_meal_plan and the new turn supplies dietary constraints
  // ("high-protein, vegetarian", "low-carb, no fish"), apply them as
  // additional args and re-emit the plan step.
  const cookingPendingContinuation = buildPendingCookingMealPlanContinuation(input, PENDING_CONTINUATION_HELPERS);
  if (cookingPendingContinuation) return cookingPendingContinuation;
  // Phase 8 batch 38 (2026-05-15): mail draft refinement continuation.
  const mailPendingContinuation = buildPendingMailDraftContinuation(input, PENDING_CONTINUATION_HELPERS);
  if (mailPendingContinuation) return mailPendingContinuation;
  // Phase 8 batch 38: decision_choose with sub-options continuation.
  const decisionPendingContinuation = buildPendingDecisionChooseContinuation(input, PENDING_CONTINUATION_HELPERS);
  if (decisionPendingContinuation) return decisionPendingContinuation;
  // Phase 8 batch 38: finance categorize-receipt category continuation.
  const financePendingContinuation = buildPendingFinanceCategorizeContinuation(input, PENDING_CONTINUATION_HELPERS);
  if (financePendingContinuation) return financePendingContinuation;
  // Phase 9 batch 44 (2026-05-16): content brief / script-create pending
  // continuation. Turn 1 invokes the brief / script intent; turn 2 supplies
  // additional spec (audience, platform-specific tone, length target).
  const contentPendingContinuation = buildPendingContentSpecContinuation(input, PENDING_CONTINUATION_HELPERS);
  if (contentPendingContinuation) return contentPendingContinuation;

  const multiStep = await tryBuildMultiStepChatActionPlan(input);
  if (multiStep) return multiStep;

  const recentFollowUp = buildRecentEntityFollowUpPlan(input);
  if (recentFollowUp) return recentFollowUp;

  const ambiguousAction = buildAmbiguousActionClarificationPlan(input);
  if (ambiguousAction) return ambiguousAction;

  if (!shouldRunActionPlannerBeforeReadOnlyFastPaths(input.text)) return null;

  return buildSingleActionChatActionPlan(input);
}

async function buildSingleActionChatActionPlan(input: ChatPlannerInput): Promise<ChatActionPlan | null> {
  const deterministic = buildDeterministicChatActionPlan(input);
  if (deterministic) return deterministic;

  const folded = foldCalendarText(input.text);
  const looksComplex = /(?:\be\b|\band\b|\+|,).{8,}/.test(folded) || selectRegistrySubsetForMessage(input.text).length > 1;
  const tier1Plan = await tryBuildTier1ClassifierPlan(input);
  if (tier1Plan) return tier1Plan;

  if (looksComplex || messageHasActionCandidate(input.text)) {
    const llmPlan = await tryBuildLlmStructuredPlan(input);
    if (llmPlan) return llmPlan;
    const reviewerPlan = await tryBuildEscalationReviewerPlan(input);
    if (reviewerPlan) return reviewerPlan;
  }

  if (messageHasActionCandidate(input.text)) {
    return buildClarificationPlan(input, input.locale?.startsWith('pt')
      ? 'Preciso só de mais detalhes para fazer isso. Qual é o título, data, hora e destino?'
      : 'I need a few more details to do that. What title, date, time, and destination should I use?');
  }
  return null;
}

async function tryBuildMultiStepChatActionPlan(input: ChatPlannerInput): Promise<ChatActionPlan | null> {
  const split = splitChatMultiStepRequest(input.text);
  if (split.classification === 'single' || split.segments.length < 2) return null;
  const routed = await routeChatMultiStepSegments(input, split.segments, buildSingleActionChatActionPlan);
  if (routed.plan) {
    return {
      ...routed.plan,
      confidence: Math.min(routed.plan.confidence, split.confidence),
      effectiveConfidence: Math.min(routed.plan.effectiveConfidence ?? routed.plan.confidence, split.confidence),
      telemetry: routed.plan.telemetry
        ? {
            ...routed.plan.telemetry,
            calibratedScore: Math.min(routed.plan.telemetry.calibratedScore, split.confidence),
          }
        : routed.plan.telemetry,
      debug: {
        routingSignals: [
          ...(routed.plan.debug?.routingSignals ?? []),
          `multi_step_split_reason:${split.reason}`,
        ],
        rejectedFastPaths: routed.plan.debug?.rejectedFastPaths ?? [],
        parser: 'mixed',
        modelProvider: routed.plan.debug?.modelProvider,
      },
    };
  }
  if (routed.blockedReason === 'segment_unresolved') {
    return buildClarificationPlan(input, input.locale?.startsWith('pt')
      ? 'Vejo mais de uma ação, mas preciso que separes melhor cada passo antes de executar.'
      : 'I see more than one action, but I need you to separate each step more clearly before I run it.');
  }
  return null;
}

function buildAmbiguousActionClarificationPlan(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  const hasScheduleVerb = /\b(schedule|plan|put|book|set up|marca|marcar|agenda|agendar|programa|programar)\b/.test(folded);
  const hasAmbiguousObject = /\b(something|anything|stuff|thing|algo|alguma coisa|coisa|qualquer coisa)\b/.test(folded);
  const hasDateHint = /\b(today|tomorrow|tonight|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hoje|amanha|amanhã|esta\s+semana|proxima\s+semana|próxima\s+semana|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo)\b/.test(folded);
  if (!hasScheduleVerb || !hasAmbiguousObject || !hasDateHint) return null;

  return buildNeedsInputPlan(input, {
    skill: 'secretary_calendar',
    action: 'schedule_event',
    question: input.locale?.startsWith('pt')
      ? 'Queres criar um evento, uma tarefa ou um lembrete?'
      : 'Should I make this an event, a task, or a reminder?',
    args: { rawRequest: input.text },
    routingSignals: ['ambiguous_action_intent', 'clarifying_question'],
    clarificationReason: 'ambiguous_intent',
    intentClass: 'clarifying_question',
  });
}

function buildPendingCancellationPlan(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  if (!/\b(cancel|cancelar|never mind|nevermind|esquece|deixa|forget it)\b/.test(folded)) return null;
  const cancelled = cancelPendingChatActions({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    nowIso: input.nowIso,
  });
  if (cancelled <= 0) return null;
  return buildMessageOnlyPlan(input, input.locale?.startsWith('pt')
    ? 'Está cancelado. Não vou continuar essa ação pendente.'
    : 'Cancelled. I will not continue that pending action.', 'pending_action_cancelled');
}

function buildRecentEntityFollowUpPlan(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  if (!/\b(mark|complete|done|finish|concluir|conclui|feito|terminar|marca)\b/.test(folded)) return null;
  if (!/\b(this task|that task|it|this|that|essa tarefa|esta tarefa|isso)\b/.test(folded)) return null;
  const resolved = resolveRecentChatEntity({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    entityType: 'task',
    action: 'complete_task',
    nowIso: input.nowIso,
  });
  if (resolved.status === 'single') {
    const entity = resolved.candidates[0];
    const args = {
      taskId: entity.entityId,
      listId: typeof entity.metadata?.listId === 'string' ? entity.metadata.listId : undefined,
      listName: typeof entity.metadata?.listName === 'string' ? entity.metadata.listName : undefined,
      title: entity.userVisibleLabel,
    };
    if (!args.listId) {
      return buildNeedsInputPlan(input, {
        skill: 'tasks',
        action: 'complete_task',
        question: input.locale?.startsWith('pt')
          ? `Qual tarefa devo concluir: ${entity.userVisibleLabel}?`
          : `Which task should I mark done: ${entity.userVisibleLabel}?`,
        args: {},
        routingSignals: ['recent_entity_followup', 'task_reference_missing_list'],
      });
    }
    const step = makeStep(input, {
      skill: 'tasks',
      action: 'complete_task',
      risk: 'safe_write',
      provider: 'nexus',
      args,
      slotProvenance: {
        taskId: makeSlotProvenance({
          slot: 'taskId',
          value: entity.entityId,
          rawText: input.text,
          turnId: input.messageId,
          sourceType: 'visible_card',
          normalizer: 'recent_entity_graph_v1',
          confidence: entity.confidence,
        }),
      },
      requiredArgsPresent: Boolean(args.taskId && args.listId),
    });
    return buildPlanFromSteps(input, [step], ['recent_entity_followup', 'task_reference_resolved'], 0.94);
  }
  const options = resolved.candidates.map((candidate) => candidate.userVisibleLabel).filter(Boolean).slice(0, 3);
  return buildNeedsInputPlan(input, {
    skill: 'tasks',
    action: 'complete_task',
    question: input.locale?.startsWith('pt')
      ? options.length > 0
        ? `Qual tarefa devo concluir: ${options.join(', ')}?`
        : 'Qual tarefa devo concluir?'
      : options.length > 0
        ? `Which task should I mark done: ${options.join(', ')}?`
        : 'Which task should I mark done?',
    args: {},
    routingSignals: [resolved.status === 'ambiguous' ? 'ambiguous_recent_task_reference' : 'missing_recent_task_reference'],
  });
}

export function buildDeterministicChatActionPlan(input: ChatPlannerInput): ChatActionPlan | null {
  const locale = input.locale || 'pt-BR';
  const nowIso = input.nowIso ?? new Date().toISOString();
  // Phase 2 batch 7 (2026-05-15): top-of-planner prompt-injection refusal.
  // The §10.1 marker check already runs inside parseSimpleTaskStep for task
  // titles. Phase 2 extends it: any embedded LLM-instruction syntax anywhere
  // in the message gates ALL deterministic parsers. The planner emits a
  // refusal-shape step (requiredArgsPresent: false, rejectedRequest in args)
  // for the would-be skill instead of letting a mutation parser claim and
  // dispatch. Refused before parseNaturalLanguageCalendarEvent so a calendar
  // write with embedded injection doesn't slip through the schedule_event path.
  const injectionRefusal = parsePromptInjectionRefusal(input);
  if (injectionRefusal) return injectionRefusal;
  const sensitiveDataRefusal = parseSensitiveDataExfiltrationRefusal(input);
  if (sensitiveDataRefusal) return sensitiveDataRefusal;
  const bulkDestructiveRefusal = parseBulkDestructiveRefusal(input);
  if (bulkDestructiveRefusal) return bulkDestructiveRefusal;
  // Phase 3 batch 12 (2026-05-15): past-tense lookalike gate. Decline to
  // claim messages that describe past mutations ("I scheduled my dentist
  // yesterday", "Já paguei a fatura", "Acabei de mandar o email"). Returns
  // null so the message falls through to conversational tiers instead of
  // triggering a new mutation. Distinct from the injection refusal (which
  // emits a refusal-shape step) — past-tense descriptions don't need to be
  // "refused", they just shouldn't be treated as action requests.
  if (hasPastTenseSignal(input.text)) return null;
  const foldedInput = foldCalendarText(input.text);
  const earlyContentSchedule = parseContentActionStep(input, foldedInput);
  if (earlyContentSchedule?.action === 'content_schedule_work'
    && !/\b(?:na\s+agenda|agenda\s+(?:do|da)\s+(?:google|gmail))\b/.test(foldedInput)
    && !/\b(event|evento|meeting|reuni[aã]o|appointment|compromisso|cita[s]?)\b/.test(foldedInput)) {
    return buildPlanFromSteps(input, [earlyContentSchedule], ['content_action_intent', 'deterministic_skill_parser', 'content_schedule_preflight'], 0.8);
  }
  // Task-with-subtasks owns legacy "create task X with subtasks A B C" before
  // the simpler create-task parser can flatten the whole tail into the title.
  const taskWithSubtasks = startsWithTaskWithSubtasksIntent(input.text) ? parseTaskWithSubtasksIntent(input) : null;
  if (taskWithSubtasks) return taskWithSubtasks;
  const taskFirst = startsWithSimpleTaskCreateIntent(input.text) ? parseSimpleTaskIntent(input) : null;
  if (taskFirst) return taskFirst;
  const calendar = parseNaturalLanguageCalendarEvent(input.text, { timezone: input.timezone, nowIso });
  if (calendar) {
    const provider = calendar.provider === 'outlook' ? 'outlook_calendar' : 'google_calendar';
    const args = {
      title: calendar.title,
      provider,
      calendarId: 'primary',
      startDateTime: calendar.startDateTime,
      endDateTime: calendar.endDateTime,
      timezone: calendar.timezone,
      attendees: calendar.attendees,
      location: calendar.location,
      notes: calendar.notes,
      recurrence: calendar.recurrence,
    };
    const step: ChatPlanStep = {
      stepId: `step-${randomUUID()}`,
      skill: 'secretary_calendar',
      type: 'schedule_event',
      action: 'schedule_event',
      risk: calendar.attendees.length > 0 ? 'external_side_effect' : 'safe_write',
      riskClass: riskClassForRisk(calendar.attendees.length > 0 ? 'external_side_effect' : 'safe_write'),
      provider,
      args,
      slotProvenance: buildCalendarSlotProvenance(input, calendar, provider),
      requiredArgsPresent: true,
      idempotencyKey: buildStepIdempotencyKey(input, 'schedule_event', args),
      verification: {
        required: true,
        method: 'provider_read_back',
        expectedFields: {
          title: calendar.title,
          provider,
          startDateTime: calendar.startDateTime,
          endDateTime: calendar.endDateTime,
          timezone: calendar.timezone,
        },
      },
    };
    const taskFollowUp = parseSimpleTaskStep(input, extractTaskClause(input.text));
    const steps = taskFollowUp ? [step, taskFollowUp] : [step];
    return {
      schemaVersion: 1,
      userId: String(input.userId),
      tenantId: String(input.tenantId),
      conversationId: input.conversationId,
      messageId: input.messageId,
      locale,
      timezone: input.timezone,
      channel: input.channel,
      createdAt: nowIso,
      planner: 'deterministic',
      steps,
      requiresConfirmation: steps.some((candidate) => stepRequiresConfirmation(candidate, {
        requireSafeWrites: input.requireSafeWriteConfirmation === true,
      })),
      confidence: calendar.confidence,
      debug: {
        routingSignals: ['calendar_write_intent', provider, 'deterministic_calendar_parser', ...(taskFollowUp ? ['task_follow_up_intent'] : [])],
        rejectedFastPaths: hasMailReadIntent(input.text) ? [] : ['gmail_unread_count'],
        parser: 'deterministic',
      },
    };
  }
  if (hasCalendarWriteIntent(input.text)) {
    return buildIncompleteCalendarCreatePlan(input);
  }

  // Phase 1 batch 4 (2026-05-15): create_checklist runs before the legacy
  // subtask guard. The task-with-subtasks parser above owns richer task
  // checklist wording; this parser keeps explicit checklist object asks.
  const checklist = parseCreateChecklistIntent(input);
  if (checklist) return checklist;
  if (hasLegacySubtaskIntent(input.text)) return null;
  // Calendar read-intent short-circuit: "What's on my agenda today" /
  // "Agenda de hoje" / "agenda do Gmail" route to summarize_agenda BEFORE
  // task or broad-skill parsing. Without this, the bare Portuguese noun
  // "agenda" gets misinterpreted as a write verb downstream. Surfaced by
  // the registry shadow-parity report 2026-05-15.
  const agendaSummary = parseSummarizeAgendaIntent(input);
  if (agendaSummary) return agendaSummary;
  // Phase 1 batch 4: check_calendar_conflicts runs before calendar mutations
  // because "Am I free at 3pm" must beat a generic "delete" verb if both
  // appear; in practice they don't, but precedence here protects future regex.
  const checkConflicts = parseCheckCalendarConflictsIntent(input);
  if (checkConflicts) return checkConflicts;
  const calendarMutation = parseCalendarMutationIntent(input);
  if (calendarMutation) return calendarMutation;
  const completeTaskByMark = parseCompleteTaskByMarkIntent(input);
  if (completeTaskByMark) return completeTaskByMark;
  const taskMutation = parseTaskMutationIntent(input);
  if (taskMutation) return taskMutation;
  const task = parseSimpleTaskIntent(input);
  if (task) return task;
  const broadAction = parseBroadSkillActionIntent(input);
  if (broadAction) return broadAction;
  return null;
}

// parseContentActionStep moved to skills/content/parser.ts on 2026-05-15
// (planner-split, audit implementation plan Phase 0).
// parseCookingActionStep moved to skills/cooking/parser.ts on 2026-05-15.
// parseFinanceActionStep moved to skills/finance/parser.ts on 2026-05-15.
// parseMailActionStep added at skills/mail/parser.ts on 2026-05-15 (Phase 1
// batch 3): the broad-skill subset fallback couldn't disambiguate
// mail_unread_count / mail_inbox_summary / draft_email / send_email; the
// new parser performs verb-class inspection to claim the right action.
// parseConnectionsActionStep moved to skills/connections/parser.ts on
// 2026-05-15 (planner-split, audit implementation plan Phase 0).

// parseTrainingActionStep moved to skills/training/parser.ts on 2026-05-15
// (planner-split, audit implementation plan Phase 0). Training helpers
// (slot extraction, validation, step construction) moved to
// skills/training/helpers.ts and re-imported above for the planner's pending-
// action continuation and action-run execution paths.

// parseNotificationActionStep moved to skills/notifications/parser.ts on
// 2026-05-15 (planner-split, audit implementation plan Phase 0).

// parseDecisionActionStep moved to skills/decision_center/parser.ts on
// 2026-05-15 (first per-skill parser extraction, planner-split foundation).

// makeStep, buildStepIdempotencyKey, normalizeHashArgs, isHashDateTimeKey,
// actionToStepType, and pickExpectedFields moved to src/services/skills/
// step-builder.ts on 2026-05-15 (planner-split foundation, audit
// implementation plan Phase 0). They are imported at the top of this file.

export async function executeChatActionPlan(
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  deps: Required<ChatActionPlannerDeps>,
  options: ChatActionExecutionOptions = {},
): Promise<ChatActionRouteResponse> {
  // Phase 16 batch 80 (2026-05-16): wrap execution in
  // runWithChatToolAuthorization. Before this fix the action planner reached
  // destructive providers (createEvent, updateEvent, deleteEvent, mail send)
  // without the tool-authorization gate at chat-tool-authorization.ts:156-164;
  // the gate was only wired into the legacy tool-call surface at
  // chat-message-routes.ts:1160. Re-entrant calls already inside an auth
  // context fall through (AsyncLocalStorage scope continues unchanged).
  if (!getCurrentChatToolAuthorizationContext()) {
    return runWithChatToolAuthorization({
      userId: input.userId,
      tenantId: input.tenantId,
      confirmedDestructiveAction: options.confirmed === true,
      confirmationSource: options.confirmationSource
        ?? (options.confirmed === true ? 'pending_confirmation' : 'none'),
      requireConfirmationForWrites: input.requireSafeWriteConfirmation === true,
    }, () => executeChatActionPlan(plan, input, deps, options));
  }
  const hasUnresolvedStep = plan.clarificationQuestion || plan.steps.some((step) => !step.requiredArgsPresent);
  if (hasUnresolvedStep) {
    // Phase 16 batch 80 (2026-05-16): refusal-vs-clarification distinction.
    // Refused plans (built by buildSafetyRefusalPlan with rejectionReason
    // populated) now take a distinct branch with metadata.actionStatus
    // 'refused' and metadata.type 'chat_action_refused'.
    const refusalReason = refusalReasonForPlan(plan);
    if (refusalReason) {
      persistPlanStatus(plan, input, 'blocked');
      const refusalMessage = refusalCopyForReason(refusalReason, input);
      return buildActionResponse(input, plan, 'blocked', refusalMessage, {
        type: 'chat_action_refused',
        actionStatus: 'refused',
        refusal: { reason: refusalReason, message: refusalMessage },
      });
    }
    persistPlanStatus(plan, input, 'needs_clarification');
    const question = plan.clarificationQuestion || defaultClarification(input);
    const clarificationReason = clarificationReasonForPlan(plan);
    return buildActionResponse(input, plan, 'needs_clarification', question, {
      type: multiStepType(plan, 'chat_action_needs_input'),
      actionStatus: 'needs_clarification',
      intentClass: plan.intentClass ?? (clarificationReason === 'ambiguous_intent' ? 'clarifying_question' : undefined),
      clarification: { question, reason: clarificationReason },
      openSurface: openSurfacePayloadForStep(plan.steps[0], null, input),
      ...multiStepMetadata(plan, []),
    });
  }

  if (plan.requiresConfirmation && options.confirmed !== true) {
    persistPlanStatus(plan, input, 'needs_confirmation');
    return buildActionResponse(input, plan, 'needs_confirmation', confirmationCopy(plan, input), {
      type: multiStepType(plan, 'chat_action_needs_confirmation'),
      actionStatus: 'needs_confirmation',
      actionConfirmation: {
        title: input.locale?.startsWith('pt') ? 'Confirmação necessária' : 'Confirmation needed',
        message: confirmationCopy(plan, input),
        destructive: plan.steps.some((step) => step.risk === 'destructive'),
        variant: confirmationVariant(plan),
        requiresStrongConfirm: plan.steps.some((step) => step.risk === 'financial' || step.risk === 'admin_security'),
        intentClass: intentClassForPlan(plan),
      },
      ...multiStepMetadata(plan, []),
    });
  }

  const results: ChatStepExecutionResult[] = [];
  for (const step of plan.steps) {
    if (step.dependsOnStepIds?.some((dep) => {
      const depResult = results.find((result) => result.step.stepId === dep);
      return !depResult || depResult.status !== 'verified_success';
    })) {
      results.push({ step, status: 'blocked', error: 'dependency_failed' });
      break;
    }
    if (step.type === 'answer') {
      results.push({ step, status: 'verified_success', result: { text: String((step.args as any).text || '') } });
      continue;
    }
    if (!step.requiredArgsPresent) {
      persistStepStatus(plan, input, step, 'needs_clarification');
      results.push({ step, status: 'needs_clarification', error: 'missing_required_fields' });
      break;
    }
    // Phase 16 batch 82 (2026-05-17): executionPolicy enforcement. Before
    // this the `executionPolicy` field on ChatActionDefinition was declared
    // but never read at runtime — an action marked `'blocked'` (the
    // registry default for `risk: 'ambiguous'`) would reach the action
    // dispatch unchallenged. Now we short-circuit before per-action
    // executors when policy says blocked.
    const stepDefinition = findChatActionDefinition(step.skill, step.action);
    if (stepDefinition?.executionPolicy === 'blocked') {
      results.push({ step, status: 'blocked', error: 'execution_policy_blocked' });
      break;
    }
    const runtimeStep: ChatPlanStep = { ...step, args: resolveStepRefs(step.args, results) };
    const executor = getChatStepExecutor(runtimeStep.action);
    if (executor) {
      const result = await executeStepWithReliability(runtimeStep, {
        plan,
        input,
        deps,
        persistRuns: input.persistRuns !== false,
        confirmed: options.confirmed === true,
      });
      results.push(result);
      if (result.status !== 'verified_success') break;
      continue;
    }
    results.push({ step: runtimeStep, status: 'blocked', error: unsupportedChatExecutorReason(runtimeStep) });
    break;
  }

  requeuePartialSuccessPendingParents(input, plan, results);

  const needsConfirmation = results.find((result) => result.status === 'needs_confirmation');
  if (needsConfirmation) {
    persistPlanStatus(plan, input, 'needs_confirmation');
    return buildActionResponse(input, plan, 'needs_confirmation', confirmationCopy(plan, input), {
      type: multiStepType(plan, 'chat_action_needs_confirmation'),
      actionStatus: 'needs_confirmation',
      actionConfirmation: {
        title: input.locale?.startsWith('pt') ? 'Confirmação necessária' : 'Confirmation needed',
        message: failureCopy(input, needsConfirmation.error),
        destructive: plan.steps.some((step) => step.risk === 'destructive'),
        variant: confirmationVariant(plan),
        requiresStrongConfirm: plan.steps.some((step) => step.risk === 'financial' || step.risk === 'admin_security'),
        intentClass: intentClassForPlan(plan),
      },
      actionResults: sanitizeActionResults(results),
      ...multiStepMetadata(plan, results),
    });
  }
  const needsClarification = results.find((result) => result.status === 'needs_clarification');
  if (needsClarification) {
    const question = plan.clarificationQuestion || buildTargetedClarificationQuestion(input, plan.steps);
    return buildActionResponse(input, plan, 'needs_clarification', question, {
      type: multiStepType(plan, 'chat_action_needs_input'),
      actionStatus: 'needs_clarification',
      clarification: { question, reason: clarificationReasonForPlan(plan) },
      actionResults: sanitizeActionResults(results),
      ...multiStepMetadata(plan, results),
    });
  }
  const failed = results.find((result) => result.status === 'failed' || result.status === 'blocked');
  const partial = results.some((result) => result.status !== 'verified_success');
  if (failed) {
    return buildActionResponse(input, plan, failed.status, failureCopy(input, failed.error), {
      type: multiStepType(plan, failed.status === 'blocked' ? 'chat_action_blocked' : 'chat_action_failed'),
      actionStatus: failed.status,
      error: { message: failureCopy(input, failed.error), retryable: failed.status !== 'blocked' },
      actionResults: sanitizeActionResults(results),
      ...multiStepMetadata(plan, results),
    });
  }
  const verifiedPending = results.find((result) => result.status === 'verified_pending');
  if (verifiedPending) {
    return buildActionResponse(input, plan, 'verified_pending', verifiedPendingCopy(input, verifiedPending), {
      type: multiStepType(plan, 'chat_action_verified_pending'),
      actionStatus: 'verified_pending',
      verificationStatus: 'verified_pending',
      openSurface: openSurfacePayloadForStep(verifiedPending.step, verifiedPending.result, input),
      actionResults: sanitizeActionResults(results),
      ...multiStepMetadata(plan, results),
    });
  }
  if (partial) {
    return buildActionResponse(input, plan, 'partial_success', partialCopy(input), {
      type: multiStepType(plan, 'chat_action_partial_success'),
      actionStatus: 'partial_success',
      actionResults: sanitizeActionResults(results),
      ...multiStepMetadata(plan, results),
    });
  }
  return buildActionResponse(input, plan, 'verified_success', successCopy(input, results), {
    type: multiStepType(plan, 'chat_action_verified_success'),
    actionStatus: 'verified_success',
    verificationStatus: 'verified_success',
    title: firstTitle(results),
    calendar: calendarCardEvents(results),
    ...resultCardPayload(results),
    actions: actionButtonsForResults(results),
    actionResults: sanitizeActionResults(results),
    ...multiStepMetadata(plan, results),
  });
}

async function executeStepWithReliability(
  step: ChatPlanStep,
  context: ChatStepExecutionContext,
): Promise<ChatStepExecutionResult> {
  const executor = getChatStepExecutor(step.action);
  if (!executor) return { step, status: 'blocked', error: unsupportedChatExecutorReason(step) };
  let result: ChatStepExecutionResult;
  try {
    result = await runChatActionWithBoundedRetry(() => executor(step, context), {
      onRetry: (event) => {
        logger.warn({
          userId: context.input.userId,
          tenantId: context.input.tenantId,
          conversationId: context.input.conversationId,
          messageId: context.input.messageId,
          skill: step.skill,
          action: step.action,
          attempt: event.attempt,
          category: event.category,
          reason: event.reason,
        }, 'Retrying transient chat action executor failure');
      },
    });
  } catch (err) {
    result = { step, status: 'failed', error: normalizeChatActionErrorReason(err).slice(0, 200) };
  }
  maybeQueueChatActionFixerReview(context.input, context.plan, step, result);
  return result;
}

function maybeQueueChatActionFixerReview(
  input: ChatPlannerInput,
  plan: ChatActionPlan,
  step: ChatPlanStep,
  result: ChatStepExecutionResult,
): void {
  if (input.persistRuns === false || result.status === 'verified_success' || !shouldQueueChatActionFixerReview(result.error)) return;
  try {
    recordChatActionTelemetry({
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      planner: plan.planner,
      status: result.status,
      skill: step.skill,
      action: step.action,
      telemetry: {
        ...(plan.telemetry ?? {
          routeTier: 'tier0_deterministic',
          candidates: [{ skill: step.skill, action: step.action, score: plan.effectiveConfidence ?? plan.confidence }],
          calibratedScore: plan.effectiveConfidence ?? plan.confidence,
          threshold: thresholdForSteps(plan.steps),
        }),
        outcome: 'requires_fixer_review',
        failureReason: result.error ?? 'unknown_error',
        verifierStatus: 'mismatch',
        predictedActionHash: step.idempotencyKey,
        slotProvenanceSummary: summarizeSlotProvenance(plan),
      },
      nowIso: input.nowIso,
    });
    enqueueChatActionFixerReview({ input, plan, step, result });
  } catch (err) {
    logger.warn({
      err,
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      skill: step.skill,
      action: step.action,
      reason: result.error,
    }, 'Chat action fixer review enqueue failed');
  }
}
