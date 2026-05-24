// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
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
  getChatActionRegistry,
  messageHasActionCandidate,
  riskClassForRisk,
  selectRegistrySubsetForMessage,
  type ChatActionName,
  type ChatActionDefinition,
  type ChatActionRisk,
  type ChatActionSkill,
  type ChatProvider,
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
  claimChatActionRun,
  claimChatActionRunForExecution,
  listPendingChatActionRuns,
  updateChatActionRun,
  type ChatActionRunRow,
  type ChatActionRunStatus,
} from '../chat-action-run-store';
import {
  cancelPendingChatActions,
  makeSlotProvenance,
  markPendingChatActionNeedsUserFollowup,
  recordChatActionTelemetry,
  rememberRecentChatEntity,
  resolveRecentChatEntity,
  upsertPendingChatAction,
  type ChatSlotProvenance,
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
  buildBlocksFromMarkdown,
} from '../chat-response-blocks';
import type { ChatResponseCard } from '../chat-response-cards';
import {
  actionToStepType,
  buildStepIdempotencyKey,
  makeStep,
  pickExpectedFields,
} from '../skills/step-builder';
import { parseConnectionsActionStep } from '../skills/connections/parser';
import { parseContentActionStep } from '../skills/content/parser';
import { buildPendingContentSpecContinuation } from '../skills/content/pending';
import { parseCookingActionStep } from '../skills/cooking/parser';
import { buildPendingCookingMealPlanContinuation } from '../skills/cooking/pending';
import { parseDecisionActionStep } from '../skills/decision_center/parser';
import { buildPendingDecisionChooseContinuation } from '../skills/decision_center/pending';
import { parseFinanceActionStep } from '../skills/finance/parser';
import { buildPendingFinanceCategorizeContinuation } from '../skills/finance/pending';
import { parseMailActionStep } from '../skills/mail/parser';
import { buildPendingMailDraftContinuation } from '../skills/mail/pending';
import { parseNotificationActionStep } from '../skills/notifications/parser';
import { hasPastTenseSignal } from '../skills/past-tense-detector';
import { extractTopic, inferContentPlatform, inferProviderName } from '../skills/text-extractors';
import {
  missingTrainingPlanSlots,
} from '../skills/training/helpers';
import { parseTrainingActionStep } from '../skills/training/parser';
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
import { buildMultiStepSummary, resolveStepRefs } from '../chat-multi-step-dag';
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
  domainForPlan,
  firstTitle,
  openSurfacePayloadForStep,
  resultCardPayload,
  sanitizeActionResults,
} from './executor/response-cards';
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
  calibratePlanConfidence,
  confirmationVariant,
  intentClassForPlan,
  normalizeProvider,
  stepRequiresConfirmation,
} from './executor/plan-utils';
import {
  buildTargetedClarificationQuestion,
  defaultClarification,
} from './planner/clarification';
import {
  finalizeTelemetryForResponse,
  recordShadowTelemetry,
  safeTelemetry,
  summarizeSlotProvenance,
  thresholdForSteps,
} from './executor/telemetry';

export { buildLlmPlannerPrompt, buildTier1ClassifierPrompt, parseLlmPlannerJson, parseTier1ClassifierJson } from './planner/tiers';

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
export const BROAD_SKILL_SLOT_COMPLETENESS_BONUS = 0.005;
export const BROAD_SKILL_MIN_PRIORITY_GAP = 0.01;
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

function hasLegacySubtaskIntent(text: string): boolean {
  const folded = foldCalendarText(text);
  return /\b(sub\s*-?\s*tasks?|subtarefas?|check\s*-?\s*list|checklist|lista de verificacao)\b/.test(folded);
}

const MAX_TASK_TITLE_LENGTH = 500;
const MAX_SUBTASK_TITLE_LENGTH = 200;
const MAX_SUBTASKS = 25;
const SUBTASK_MARKER_PATTERNS = /\b(sub\s*tasks?|subtasks?|subtarefas?|subtareas?|checklist(?:\s+items?)?|steps?|itens?|elementos?)\b/i;
const SUBTASK_SECOND_ACTION = /\b(and|e|y)\s+(?:remind|schedule|reschedule|cancel|delete|move|plan|mark|create|add|lembrar|agenda|agendar|remarcar|cancela|cancelar|apaga|apagar|mover|marcar|cria|criar|crear|programar|recordar|eliminar|borrar|añade|anade)\b/i;
const TASK_DISCOURSE_TAILS = [
  /\bfor now(?:\s+that'?s\s+it)?\.?$/i,
  /\bthat'?s\s+(?:it|all)\.?$/i,
  /\band\s+that'?s\s+all\.?$/i,
  /\bjust\s+this\.?$/i,
  /\bnothing\s+else\.?$/i,
  /\bpor\s+agora(?:\s+e\s+so\s+isso)?\.?$/i,
  /\bé\s+só\s+isso\.?$/i,
  /\be\s+so\s+isso\.?$/i,
];

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

// Phase 2 batch 7 (2026-05-15): top-of-planner prompt-injection refusal.
// Emits a refusal-shape step (`requiredArgsPresent: false`,
// `args.rejectedRequest = <original text>`) instead of letting a mutation
// parser claim. The skill+action is inferred from the registry subset so the
// downstream UI surfaces the right card.
function parsePromptInjectionRefusal(input: ChatPlannerInput): ChatActionPlan | null {
  if (!containsPromptInjectionMarker(input.text)) return null;
  return buildSafetyRefusalPlan(input, 'prompt_injection_marker_detected', [
    'prompt_injection_refusal',
    'deterministic_safety_gate',
  ]);
}

function parseSensitiveDataExfiltrationRefusal(input: ChatPlannerInput): ChatActionPlan | null {
  if (!containsSensitiveDataExfiltrationRequest(input.text)) return null;
  return buildSafetyRefusalPlan(input, 'sensitive_data_exfiltration_detected', [
    'sensitive_data_exfiltration_refusal',
    'deterministic_safety_gate',
  ], { skill: 'mail', action: 'send_email' });
}

function parseBulkDestructiveRefusal(input: ChatPlannerInput): ChatActionPlan | null {
  if (!containsBulkDestructiveRequest(input.text)) return null;
  return buildSafetyRefusalPlan(input, 'bulk_destructive_request_detected', [
    'bulk_destructive_refusal',
    'deterministic_safety_gate',
  ], { skill: 'tasks', action: 'delete_task' });
}

function buildIncompleteCalendarCreatePlan(input: ChatPlannerInput): ChatActionPlan {
  const isPortuguese = input.locale?.startsWith('pt');
  const isSpanish = input.locale?.startsWith('es');
  return buildNeedsInputPlan(input, {
    skill: 'secretary_calendar',
    action: 'schedule_event',
    question: isPortuguese
      ? 'Para agendar isso, preciso do horário e do título do evento.'
      : isSpanish
        ? 'Para programar eso, necesito la hora y el título del evento.'
        : 'To schedule that, I need the event time and title.',
    args: { rawRequest: input.text },
    routingSignals: ['calendar_write_intent_incomplete', 'deterministic_calendar_parser'],
  });
}

function buildSafetyRefusalPlan(
  input: ChatPlannerInput,
  rejectionReason: string,
  routingSignals: string[],
  fallback?: { skill: ChatActionSkill; action: ChatActionName },
): ChatActionPlan | null {
  // Infer the would-be skill from the registry subset. If the subset is empty
  // (the message doesn't look like any action), return null and let the rest
  // of the planner drop the message naturally — there is nothing to refuse.
  const subset = selectRegistrySubsetForMessage(input.text);
  const primary = subset[0] ?? (fallback
    ? getChatActionRegistry().find((entry) => entry.skill === fallback.skill && entry.action === fallback.action)
    : undefined);
  if (!primary) return null;
  const step = makeStep(input, {
    skill: primary.skill,
    action: primary.action,
    risk: 'ambiguous',
    provider: primary.providerDependencies[0] ?? 'nexus',
    args: {
      rejectedRequest: input.text,
      rejectionReason,
      ...(rejectionReason === 'bulk_destructive_request_detected' ? { rejectedTitle: input.text } : {}),
    },
    requiredArgsPresent: false,
  });
  return buildPlanFromSteps(
    input,
    [step],
    routingSignals,
    0.55,
  );
}

function containsSensitiveDataExfiltrationRequest(text: string): boolean {
  const folded = foldCalendarText(text);
  const mailOrExportIntent = /\b(send|draft|email|e-mail|forward|share|export|manda|envia|enviar|encaminha|reenviar)\b/.test(folded);
  const collectionIntent = /\b(all|every|todos|todas|containing|include|inclui|incluir|contendo|contenga|contener)\b/.test(folded);
  const sensitivePayload = /\b(provider\s+tokens?|access\s+tokens?|refresh\s+tokens?|oauth|api\s+keys?|client\s+secrets?|payment\s+confirmations?|stripe\s+receipts?|customer\s+emails?|backup\s+keys?|passwords?|senhas?|credenciais|credentials?)\b/.test(folded);
  return mailOrExportIntent && collectionIntent && sensitivePayload;
}

function containsBulkDestructiveRequest(text: string): boolean {
  const folded = foldCalendarText(text);
  if (/\b(create|add|cria|criar|adiciona|adicionar|crea|crear)\b.*\b(called|named|titled|chamad[oa]|llamad[ao]|titulad[ao])\b/.test(folded)) {
    return false;
  }
  const destructiveVerb = /\b(delete|remove|erase|wipe|cancel|apaga|apagar|elimina|eliminar|borra|borrar|cancela|cancelar)\b/.test(folded);
  const bulkTarget = /\b(every|all|everything|entire|history|todos|todas|todo\s+o|toda\s+a|todos\s+os|todas\s+as|cada|hist[oó]rico|todas\s+las|todos\s+los)\b/.test(folded);
  const object = /\b(tasks?|tarefas?|tareas?|events?|eventos?|calendar|calend[aá]rio|emails?|messages?|mensagens|correos?)\b/.test(folded);
  return destructiveVerb && bulkTarget && object;
}

function parseSummarizeAgendaIntent(input: ChatPlannerInput): ChatActionPlan | null {
  if (!hasCalendarReadIntent(input.text)) return null;
  const folded = foldCalendarText(input.text);
  // Provider hint: "agenda do gmail" routes to google_calendar by behaviour
  // case #5 (audit §11). Default is unscoped; the engine consults connected
  // providers downstream when no hint is given.
  const provider = /\b(gmail|google)\b/.test(folded)
    ? 'google_calendar'
    : /\boutlook\b/.test(folded)
      ? 'outlook_calendar'
      : undefined;
  const baseDay = DateTime.fromISO(input.nowIso ?? new Date().toISOString()).setZone(input.timezone);
  const agendaDay = /\b(tomorrow|amanh[aã]|ma[nñ]ana)\b/.test(folded)
    ? baseDay.plus({ days: 1 })
    : baseDay;
  const args: Record<string, unknown> = { date: agendaDay.toISODate() };
  if (provider) args.provider = provider;
  const step = makeStep(input, {
    skill: 'secretary_calendar',
    action: 'summarize_agenda',
    risk: 'read_only',
    provider: provider ?? 'nexus',
    args,
    requiredArgsPresent: true,
  });
  return buildPlanFromSteps(input, [step], ['calendar_read_intent', 'summarize_agenda_short_circuit'], 0.82);
}

function parseCompleteTaskByMarkIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  // Portuguese / English mark-as-done patterns that signal complete_task
  // without a "create/cria" verb. Surfaced by the registry shadow-parity
  // report 2026-05-15 — previously fell through to the generic-fallback
  // first-action-in-subset path and incorrectly emitted create_task.
  const isMarkAsDone =
    /\b(marca|marcar|marc[aá]\-?la)\s+(?:essa|esta|a|essa\s+tarefa|esta\s+tarefa|isso)\s+(?:tarefa\s+)?(?:como\s+)?(?:feita|conclu[ií]da|pronta|done|complete[da]?)\b/.test(folded)
    || /\b(mark|set)\s+(?:this|that|the)\s+task\s+(?:as\s+)?(?:done|complete[d]?)\b/.test(folded)
    || /\b(concluir|conclui|finaliza|finalizar)\s+(?:essa|esta|a)\s+tarefa\b/.test(folded)
    // Phase 7 close-out: informal "tick off" / "check off" complete verbs.
    || /\b(tick|check)\s+off\s+(?:the|this|that|my)\s+\w+\s+task\b/.test(folded)
    // Phase 9 batch 48: Spanish "marca esa tarea como hecha".
    || /\b(marca|marcar)\s+(?:esa|esta|la)\s+tarea\s+(?:como\s+)?(?:hecha|hecho|completada|completado|terminada|terminado|lista)\b/.test(folded);
  if (!isMarkAsDone) return null;
  const step = makeStep(input, {
    skill: 'tasks',
    action: 'complete_task',
    risk: 'safe_write',
    provider: 'nexus',
    // taskId resolution happens via the recent-entity follow-up plan upstream
    // (buildRecentEntityFollowUpPlan in buildChatActionPlan). Here we mark the
    // step as not-yet-resolved; the engine will ask for clarification when
    // multiple recent tasks are candidates.
    args: { taskId: null },
    requiredArgsPresent: false,
  });
  return buildPlanFromSteps(input, [step], ['task_complete_by_mark_intent', 'deterministic_task_parser'], 0.78);
}

// Phase 1 batch 4 (2026-05-15): task mutation intents — delete/update/reminder.
// Pattern mirrors parseCompleteTaskByMarkIntent: identify the mutation verb,
// claim the action with `taskId: null`, and defer resolution to the
// recent-entity follow-up path. Must run AFTER parseSimpleTaskIntent only
// when the user explicitly references an existing task — guarded by NO
// create-verb anywhere in the message so "create a task called delete all my
// tasks" continues to route to create_task.
function parseTaskMutationIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  // Phase 9 batch 48 (2026-05-16): Spanish `tarea` accepted in outer gate.
  if (!/\b(task|tarefa|todo|lembrete|tarea[s]?)\b/.test(folded)) return null;
  // Defer to parseSimpleTaskIntent when a create-verb opens the message. The
  // literal-title policy (audit §10) means create wins over the embedded
  // delete/update verb inside a title span — "Create a task called delete all
  // my tasks" stays a create. We use ^-anchored detection so "delete the laundry
  // task" (no leading create) still routes here.
  if (/^\s*(?:cria[r]?|criar|adiciona[r]?|adicionar|create|add|new)\b/i.test(input.text)
    && /\b(cria[r]?|criar|adiciona[r]?|adicionar|create|add|new)\b\s+(?:um[a]?|uma|a|o|new)?\s*(?:task|tarefa|todo|lembrete)\b/.test(folded)) {
    return null;
  }

  // Set-reminder must be checked BEFORE update/delete because "definir um
  // lembrete na tarefa" contains both `lembrete` and the noun `tarefa`, and we
  // want it routed to set_task_reminder, not finance_create_reminder via the
  // broad-skill subset. Includes PT verb forms `define`/`defina`/`definir`.
  if (/\b(set\s+(?:a\s+)?reminder|defin[aeio](?:r|m|ndo)?\s+(?:um\s+)?lembrete|remind\s+me\s+(?:about|on)|lembra[r]?\s+(?:me\s+)?(?:d[aoe]|sobre|na)|pon(?:er|me)?\s+(?:un\s+)?recordatorio|programa[r]?\s+(?:un\s+)?recordatorio)\b.*\b(task|tarefa|tarea)\b/.test(folded)
    || /\b(?:task|tarefa|tarea)\b.*\b(set\s+(?:a\s+)?reminder|defin[aeio](?:r|m|ndo)?\s+(?:um\s+)?lembrete|pon(?:er|me)?\s+(?:un\s+)?recordatorio|programa[r]?\s+(?:un\s+)?recordatorio)\b/.test(folded)) {
    return buildTaskMutationPlan(input, 'set_task_reminder', 'safe_write');
  }
  // Delete: verb appears followed (anywhere) by tarefa/task.
  // Phase 2 batch 10: PT-BR "deleta"/"exclui" added to the verb set so
  // "Deleta a tarefa" routes correctly. The English verbs cover BR+PT
  // mixed usage too.
  // Phase 9 batch 48: Spanish "borra"/"borrar" added; "tarea" accepted.
  if (/\b(delete|remove|apaga[r]?|elimina[r]?|deleta[r]?|excluir?|exclui[mr]?|borra[r]?)\b[^.]*\b(tarefa|task|tarea)\b/.test(folded)) {
    return buildTaskMutationPlan(input, 'delete_task', 'destructive');
  }
  // Update / change / edit: verb followed by tarefa/task somewhere later.
  // Phase 3 batch 15: PT-BR `muda[r]?` (BR colloquial for "altera/change")
  // added so "Muda a tarefa pra terça" routes correctly.
  // Phase 9 batch 48: Spanish "cambia/cambiar" added; "tarea" accepted.
  if (/\b(update|change|edit|rename|atualiza[r]?|altera[r]?|modifica[r]?|renomeia[r]?|muda[r]?|cambia[r]?)\b[^.]*\b(tarefa|task|tarea)\b/.test(folded)) {
    return buildTaskMutationPlan(input, 'update_task', 'safe_write');
  }
  return null;
}

function buildTaskMutationPlan(
  input: ChatPlannerInput,
  action: 'delete_task' | 'update_task' | 'set_task_reminder',
  risk: ChatActionRisk,
): ChatActionPlan {
  const step = makeStep(input, {
    skill: 'tasks',
    action,
    risk,
    provider: 'nexus',
    args: action === 'set_task_reminder'
      ? { taskId: null, reminderAt: null }
      : { taskId: null },
    requiredArgsPresent: false,
  });
  return buildPlanFromSteps(input, [step], [`task_${action}_intent`, 'deterministic_task_parser'], 0.76);
}

function parseTaskWithSubtasksIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const cleaned = stripTaskDiscourseTail(input.text.trim());
  if (!cleaned) return null;
  if (SUBTASK_SECOND_ACTION.test(cleaned)) {
    return buildNeedsInputPlan(input, {
      skill: 'tasks',
      action: 'create_task_with_subtasks',
      question: input.locale?.startsWith('pt')
        ? 'Vejo mais de uma ação nesse pedido. Confirma primeiro a tarefa com subtarefas ou pede uma pré-visualização completa.'
        : 'I see more than one action in that request. Confirm the task with subtasks first, or ask me to preview the full plan.',
      args: { title: null, subtasks: [] },
      routingSignals: ['task_with_subtasks_multi_step_guard', 'deterministic_task_parser'],
      clarificationReason: 'ambiguous_intent',
      intentClass: 'multi_step_preview_required',
    });
  }

  const quoted = extractTaskQuotedSegments(cleaned);
  const addFrame = parseAddSubtasksDescriptor(cleaned, quoted);
  if (addFrame?.multiRecipient) {
    return buildNeedsInputPlan(input, {
      skill: 'tasks',
      action: 'add_subtasks_to_task',
      question: input.locale?.startsWith('pt')
        ? 'Quais subtarefas pertencem a qual tarefa? Posso atualizar uma tarefa de cada vez.'
        : 'Which subtasks belong to which task? I can update one task at a time.',
      args: { title: null, subtasks: [] },
      routingSignals: ['multi_recipient_subtask_update', 'deterministic_task_parser'],
      clarificationReason: 'ambiguous_intent',
      intentClass: 'task_update',
    });
  }
  if (addFrame) return buildTaskSubtasksActionPlan(input, 'add_subtasks_to_task', addFrame, 0.88, ['add_subtasks_to_task_intent', 'deterministic_task_parser']);

  const checklistFrame = parseChecklistTaskDescriptor(cleaned);
  if (checklistFrame) return buildTaskSubtasksActionPlan(input, 'create_task_with_subtasks', checklistFrame, 0.9, ['create_checklist_task_intent', 'deterministic_task_parser']);

  const createFrame = parseCreateTaskWithSubtasksDescriptor(cleaned, quoted)
    ?? parseImplicitTaskWithSubtasksDescriptor(cleaned);
  if (createFrame) return buildTaskSubtasksActionPlan(input, 'create_task_with_subtasks', createFrame, createFrame.confidence, ['create_task_with_subtasks_intent', 'deterministic_task_parser']);

  const multipleTasks = parseCreateMultipleTasksDescriptor(cleaned);
  if (multipleTasks) {
    return buildNeedsInputPlan(input, {
      skill: 'tasks',
      action: 'create_task',
      question: input.locale?.startsWith('pt')
        ? 'Queres criar tarefas separadas? Confirma uma de cada vez ou pede uma pré-visualização completa.'
        : 'Do you want separate tasks? Confirm them one at a time, or ask me to preview the full plan.',
      args: { tasks: multipleTasks.tasks },
      routingSignals: ['bulk_task_creation_guard', 'deterministic_task_parser'],
      clarificationReason: 'ambiguous_intent',
      intentClass: 'task_create',
    });
  }

  return null;
}

function buildTaskSubtasksActionPlan(
  input: ChatPlannerInput,
  action: 'create_task_with_subtasks' | 'add_subtasks_to_task',
  descriptor: { title: string; subtasks: string[]; language?: string },
  confidence: number,
  routingSignals: string[],
): ChatActionPlan {
  const args = {
    title: descriptor.title,
    subtasks: descriptor.subtasks,
    dueAt: null,
    reminderAt: null,
    notes: null,
    priority: null,
    list: null,
    language: descriptor.language ?? detectTaskLanguage(input.text),
    extractionConfidence: confidence,
  };
  const step = makeStep(input, {
    skill: 'tasks',
    action,
    risk: 'safe_write',
    provider: 'nexus',
    args,
    requiredArgsPresent: Boolean(descriptor.title && descriptor.subtasks.length > 0),
  });
  return buildPlanFromSteps(input, [step], routingSignals, confidence);
}

function parseCreateTaskWithSubtasksDescriptor(
  cleaned: string,
  quoted: string[],
): { title: string; subtasks: string[]; language: string; confidence: number } | null {
  if (!SUBTASK_MARKER_PATTERNS.test(removeTaskQuotedSegments(cleaned))) return null;
  const marker = /(.*?)\b(?:where\s+it\s+has|with|including|that\s+has|com|incluindo|con)?\s*(?:sub\s*tasks?|subtasks?|subtarefas?|subtareas?|checklist(?:\s+items?)?|steps?|itens?|elementos?)\s*(?:called|named|chamadas?|chamados?|llamadas?|llamados?)?\s+(.+)$/i;
  const match = cleaned.match(marker);
  if (!match) return null;

  const title = extractTaskSubtaskTitle(match[1] || '', quoted);
  const subtasks = splitTaskSubtaskItems(match[2] || '');
  if (!title || subtasks.length === 0) return null;
  return { title, subtasks, language: detectTaskLanguage(cleaned), confidence: 0.94 };
}

function parseChecklistTaskDescriptor(cleaned: string): { title: string; subtasks: string[]; language: string } | null {
  const match = cleaned.match(/^\s*(?:create|make|cria|criar|crie|crear|crea)\s+(?:a\s+|uma?\s+|una?\s+)?checklist\s+(?:called|named|chamado|chamada|llamado|llamada)?\s*(.+?)\s*:\s*(.+)$/i);
  if (!match) return null;
  const title = normalizeTaskGuidanceTitle(match[1]);
  const subtasks = splitTaskSubtaskItems(match[2]);
  if (!title || subtasks.length === 0) return null;
  return { title, subtasks, language: detectTaskLanguage(cleaned) };
}

function parseImplicitTaskWithSubtasksDescriptor(cleaned: string): { title: string; subtasks: string[]; language: string; confidence: number } | null {
  const match = cleaned.match(/^\s*(?:cria|criar|crie|crear|crea)\s+(?:uma?\s+|una?\s+)?(?:tarefa|tarea)\s+(?:chamada?|chamado|llamada?|llamado)?\s*(.+?)\s+(?:com|con)\s+(.+)$/i);
  if (!match) return null;
  const title = normalizeTaskGuidanceTitle(match[1]);
  const subtasks = splitTaskSubtaskItems(match[2]);
  if (!title || subtasks.length < 2) return null;
  return { title, subtasks, language: detectTaskLanguage(cleaned), confidence: 0.86 };
}

function parseAddSubtasksDescriptor(
  cleaned: string,
  quoted: string[],
): { title: string; subtasks: string[]; language: string; multiRecipient?: boolean } | null {
  const textWithoutQuotes = removeTaskQuotedSegments(cleaned);
  if (!/^\s*(add|adiciona|adicionar|añade|anade|añadir|anadir|agrega|agregar)\b/i.test(textWithoutQuotes)) return null;
  if (/^\s*(?:add|adiciona|adicionar|añade|anade|añadir|anadir|agrega|agregar)\s+(?:a\s+|uma?\s+|una?\s+)?(?:task|todo|tarefa|tarea)\b/i.test(textWithoutQuotes)) return null;
  if (hasMultiRecipientSubtaskIntent(textWithoutQuotes)) {
    return { title: 'multiple tasks', subtasks: [], language: detectTaskLanguage(cleaned), multiRecipient: true };
  }
  const match = cleaned.match(/^\s*(?:add|adiciona|adicionar|añade|anade|añadir|anadir|agrega|agregar)\s+(.+?)\s+(?:to|under|à|a|na|no|en|bajo)\s+(?:my\s+|minha\s+|meu\s+|mi\s+|the\s+|la\s+|el\s+)?(?:task\s+|tarefa\s+|tarea\s+)?(.+?)(?:\s+task|\s+tarefa|\s+tarea)?$/i);
  if (!match) return null;
  const subtasks = splitTaskSubtaskItems(match[1]);
  const title = normalizeTaskGuidanceTitle(stripTaskArticleAndWords(match[2], quoted));
  if (!title || subtasks.length === 0) return null;
  return { title, subtasks, language: detectTaskLanguage(cleaned) };
}

function parseCreateMultipleTasksDescriptor(cleaned: string): { tasks: string[] } | null {
  const match = cleaned.match(/^\s*(?:create|cria|criar|crie|crear|crea)\s+(?:(\d+|three|two|multiple|varias|várias|duas|tres|três|dos)\s+)?(?:tasks|tarefas|tareas)\b[:\s]*(.+)$/i);
  if (!match) return null;
  const listPart = match[2] || '';
  if (!match[1] && !/(?:,|;|\n|\u2022|•|\band\b|\be\b|\by\b)/i.test(listPart)) return null;
  const tasks = splitTaskSubtaskItems(listPart);
  return tasks.length < 2 ? null : { tasks };
}

// Phase 1 batch 4: create_checklist intent. Distinct from create_task by the
// explicit "checklist" object plus enumerated items. We route deterministically
// when the user provides items inline; otherwise we defer to broader parsers.
function parseCreateChecklistIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  // Phase 12 batch 66 (2026-05-16): Spanish "crea[r]?" / "a[nñ]ade"
  // added to create-verb set. Checklist noun unchanged — Spanish uses
  // the loan word "checklist".
  if (!/\b(create|cria[r]?|crea[r]?|adiciona[r]?|a[nñ]ade|monta[r]?|fa[czc]a?[r]?|build|new)\b/.test(folded)) return null;
  if (!/\b(checklist|lista\s+de\s+verifica[cç][aã]o|sub-?tarefas?|subtarefas?)\b/.test(folded)) return null;
  const title = extractTopicFromChecklist(input.text) || 'Checklist';
  const items = extractChecklistItems(input.text);
  const step = makeStep(input, {
    skill: 'tasks',
    action: 'create_checklist',
    risk: 'safe_write',
    provider: 'nexus',
    args: { title, items },
    requiredArgsPresent: Boolean(title && items.length > 0),
  });
  return buildPlanFromSteps(input, [step], ['create_checklist_intent', 'deterministic_task_parser'], 0.74);
}

function extractTopicFromChecklist(text: string): string | null {
  // "create a checklist for trip prep with passport, tickets" → "trip prep"
  // "cria uma checklist para a viagem com passaporte, bilhetes" → "a viagem"
  const match = text.match(/\b(?:checklist|sub-?tarefas?|subtarefas?)\s+(?:for|para|sobre|de|do|da)\s+([^,.:;]+?)(?:\s+with\b|\s+com\b|[,.:;]|$)/i);
  return match?.[1]?.trim() || null;
}

function extractChecklistItems(text: string): string[] {
  // Items after "with" / "com" / ":" — comma-or-semicolon separated.
  // Phase 12 batch 66: Spanish "y" added as a list conjunction.
  const match = text.match(/\b(?:with|com|con)\s+(.+)$/i) || text.match(/:\s*(.+)$/);
  if (!match) return [];
  return match[1]
    .split(/[,;]\s*|\s+e\s+|\s+y\s+|\s+and\s+/i)
    .map((item) => item.trim().replace(/[.?!]+$/g, ''))
    .filter((item) => item.length > 0 && item.length < 80)
    .slice(0, 20);
}

function stripTaskDiscourseTail(value: string): string {
  let output = value.trim();
  for (const pattern of TASK_DISCOURSE_TAILS) output = output.replace(pattern, '').trim();
  return output
    .replace(/\bfor now(?:\s+that'?s\s+it)?\b/gi, ' ')
    .replace(/\bthat'?s\s+(?:it|all)\b/gi, ' ')
    .replace(/\band\s+that'?s\s+all\b/gi, ' ')
    .replace(/\bjust\s+this\b/gi, ' ')
    .replace(/\bnothing\s+else\b/gi, ' ')
    .replace(/\bpor\s+agora(?:\s+e\s+so\s+isso)?\b/gi, ' ')
    .replace(/\bé\s+só\s+isso\b/gi, ' ')
    .replace(/\be\s+so\s+isso\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.。]+$/g, '')
    .trim();
}

function extractTaskQuotedSegments(value: string): string[] {
  const matches = [...value.matchAll(/"([^"]+)"|“([^”]+)”|'([^']+)'|‘([^’]+)’/g)];
  return matches
    .map((match) => (match[1] || match[2] || match[3] || match[4] || '').trim())
    .filter(Boolean);
}

function replaceTaskQuotedSegments(value: string): string {
  let index = 0;
  return value.replace(/"([^"]+)"|“([^”]+)”|'([^']+)'|‘([^’]+)’/g, () => `__QUOTE_${index++}__`);
}

function removeTaskQuotedSegments(value: string): string {
  return replaceTaskQuotedSegments(value);
}

function normalizeTaskGuidanceTitle(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[:\-–—\s]+|[:\-–—\s.!?]+$/g, '')
    .slice(0, MAX_TASK_TITLE_LENGTH)
    .trim();
}

function normalizeTaskGuidanceComparable(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function splitTaskSubtaskItems(value: string): string[] {
  const stripped = stripTaskDiscourseTail(value)
    .replace(/^\s*(called|named|chamadas?|chamados?|llamadas?|llamados?)\s+/i, '')
    .trim();
  const quoted = extractTaskQuotedSegments(stripped);
  if (quoted.length > 0) return normalizeTaskSubtaskList(quoted);

  const commaSplit = stripped
    .split(/\s*(?:,|;|\n|\u2022|•)\s*|\s+(?:and|e|y)\s+/g)
    .map(normalizeTaskGuidanceTitle)
    .filter(Boolean);
  if (commaSplit.length > 1) return normalizeTaskSubtaskList(commaSplit);

  const words = stripped.split(/\s+/).map(normalizeTaskGuidanceTitle).filter(Boolean);
  if (words.length >= 2 && words.every((word) => /^[\p{L}\p{N}][\p{L}\p{N}+.-]*$/u.test(word))) {
    return normalizeTaskSubtaskList(words);
  }
  return normalizeTaskSubtaskList([stripped]);
}

function normalizeTaskSubtaskList(value: unknown): string[] {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of input) {
    const normalized = normalizeTaskGuidanceTitle(item);
    if (!normalized) continue;
    const key = normalizeTaskGuidanceComparable(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized.slice(0, MAX_SUBTASK_TITLE_LENGTH).trim());
    if (output.length >= MAX_SUBTASKS) break;
  }
  return output;
}

function extractTaskSubtaskTitle(prefix: string, quoted: string[]): string {
  const withoutQuoted = removeTaskQuotedSegments(prefix);
  const hasQuotedTitle = quoted.length > 0 && /\b(called|named|chamada?|chamado?|llamada?|llamado?)\s+__QUOTE_0__/i.test(replaceTaskQuotedSegments(prefix));
  if (hasQuotedTitle) return normalizeTaskGuidanceTitle(quoted[0]);

  let title = prefix
    .replace(/^\s*(please\s+)?(create|add|make|cria|criar|crie|adiciona|adicionar|crear|crea|agrega|agregar|añade|anade|añadir|anadir)\s+/i, '')
    .replace(/^\s*(a|one|uma|um|una|un)\s+/i, '')
    .replace(/^\s*(tasks?|todo|to-do|tarefas?|tareas?|checklist)\s+/i, '')
    .replace(/^\s*(called|named|chamada?|chamado?|llamada?|llamado?)\s+/i, '')
    .replace(/\s+(where\s+it\s+has|with|including|that\s+has|com|incluindo|con)\s*$/i, '')
    .trim();
  if (quoted.length > 0 && replaceTaskQuotedSegments(title).trim() === '__QUOTE_0__') return normalizeTaskGuidanceTitle(quoted[0]);
  const quotedOnly = title.match(/^["“”'‘’]([^"“”'‘’]+)["“”'‘’]$/);
  if (quotedOnly?.[1]) return normalizeTaskGuidanceTitle(quotedOnly[1]);
  if (!title && quoted.length > 0 && withoutQuoted.includes('__QUOTE_0__')) title = quoted[0];
  return normalizeTaskGuidanceTitle(title.replace(/__QUOTE_\d+__/g, '').trim());
}

function stripTaskArticleAndWords(value: string, quoted: string[]): string {
  const withPlaceholders = replaceTaskQuotedSegments(value);
  const replaced = withPlaceholders.replace(/__QUOTE_(\d+)__/g, (_all, index) => quoted[Number(index)] || '');
  return replaced
    .replace(/^\s*(the|a|uma|um|una|un|minha|meu|my|mi|la|el|los|las)\s+/i, '')
    .replace(/\s*(task|tarefa|tarea)\s*$/i, '')
    .trim();
}

function detectTaskLanguage(value: string): 'en' | 'pt' | 'es' | 'mixed' | 'unknown' {
  const hasPortuguese = /\b(cria|criar|crie|tarefa|subtarefas?|adiciona|por agora|é só isso)\b/i.test(value);
  const hasSpanish = /\b(crea|crear|tarea|subtareas?|añade|anade|agrega|con|llamada?|llamado?)\b/i.test(value);
  const hasEnglish = /\b(create|task|subtasks?|add|called|for now)\b/i.test(value);
  if ([hasPortuguese, hasSpanish, hasEnglish].filter(Boolean).length > 1) return 'mixed';
  if (hasSpanish) return 'es';
  if (hasPortuguese) return 'pt';
  if (hasEnglish) return 'en';
  return 'unknown';
}

function hasMultiRecipientSubtaskIntent(value: string): boolean {
  const targetClauses = value.match(/\b(?:to|under|à|a|na|no|en|bajo)\b/gi) || [];
  return targetClauses.length > 1 && /\b(and|e|y)\b/i.test(value);
}

function startsWithTaskWithSubtasksIntent(text: string): boolean {
  const folded = foldCalendarText(text).replace(/^(?:please|por favor|pfv)\s+/, '');
  return /^\s*(?:create|make|cria[r]?|crie|crea[r]?|agrega[r]?)\b[\s\S]{0,50}\b(?:task|todo|tarefa|tarea)\b/.test(folded)
    || /^\s*(?:add|adiciona[r]?|a[nñ]ade|a[nñ]adir|agrega[r]?)\b/.test(folded);
}

// Phase 1 batch 4: calendar mutation intents — update/move/delete event.
// Mirrors parseTaskMutationIntent: claim the action with `eventId: null` and
// let the recent-entity follow-up resolve which event the user means.
// Must run BEFORE parseNaturalLanguageCalendarEvent at the top of the planner
// would not match these (because they lack a full title+time tuple), but we
// still defer to that path when both a clear event title AND new time are
// present — the calendar-write parser handles "schedule a meeting" cleanly.
function parseCalendarMutationIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  // Gate: must explicitly reference a calendar object.
  // Phase 8 batch 43: Spanish "reunion"/"cita" added alongside PT-EN nouns.
  const hasCalObject = /\b(event|evento|meeting|reuni[aã]o|reunion[es]?|cita[s]?|appointment|compromisso|consulta|consult|dentist|dentista|standup|sync|sincronia|catch[\s-]?up|agenda|appointment)\b/.test(folded);
  if (!hasCalObject) return null;

  // Delete / cancel intent.
  // Phase 3 batch 16 (2026-05-15): "drop the X" added as informal cancel verb.
  if (/\b(cancel|delete|remove|apaga[r]?|cancela[r]?|elimina[r]?|drop)\b/.test(folded)) {
    return buildCalendarMutationPlan(input, 'delete_event', 'destructive');
  }
  // Move / reschedule intent.
  // Phase 12 batch 66 (2026-05-16): Spanish "mueve" (imperative of mover)
  // and "reprograma[r]?" (reschedule) added.
  if (/\b(move|reschedule|push|reagenda[r]?|remarca[r]?|mover|mueve[r]?|reprograma[r]?|adia[r]?)\b/.test(folded)) {
    return buildCalendarMutationPlan(input, 'move_event', 'safe_write');
  }
  // Update / change intent.
  // Phase 11 batch 58 (2026-05-16): Spanish "cambia[r]?" (the most common
  // ES verb for "change") added. "modifica[r]?" already covered both PT
  // and ES forms.
  if (/\b(update|change|edit|atualiza[r]?|altera[r]?|modifica[r]?|cambia[r]?|rename|renomeia[r]?)\b/.test(folded)) {
    return buildCalendarMutationPlan(input, 'update_event', 'safe_write');
  }
  return null;
}

function buildCalendarMutationPlan(
  input: ChatPlannerInput,
  action: 'update_event' | 'move_event' | 'delete_event',
  risk: ChatActionRisk,
): ChatActionPlan {
  const folded = foldCalendarText(input.text);
  const provider = /\b(outlook)\b/.test(folded) ? 'outlook_calendar' : 'google_calendar';
  const args: Record<string, unknown> = { eventId: null, provider };
  if (action === 'move_event') {
    args.startDateTime = null;
    args.endDateTime = null;
  } else if (action === 'update_event') {
    args.changedFields = null;
  }
  const step = makeStep(input, {
    skill: 'secretary_calendar',
    action,
    risk,
    provider,
    args,
    requiredArgsPresent: false,
  });
  return buildPlanFromSteps(input, [step], [`calendar_${action}_intent`, 'deterministic_calendar_parser'], 0.76);
}

// Phase 1 batch 4: check_calendar_conflicts — state-free intent that needs only
// a time range. Claims when the user asks "am I free at X" / "estou livre em
// X". Distinct from summarize_agenda (which asks for the day's events) by
// asking whether a specific slot is busy.
function parseCheckCalendarConflictsIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  const isFreeBusyQuestion =
    /\b(am\s+i\s+free|do\s+i\s+have\s+(?:anything|something)|do\s+i\s+have\s+free\s+time|check\s+(?:my\s+|for\s+)?(?:conflict|availability))\b/.test(folded)
    // Phase 3 batch 15: PT-BR "tô livre" / "tô disponivel" (BR contraction
    // of "estou") added alongside PT-PT phrasings.
    || /\b((?:estou|t[oô])\s+(?:livre|disponivel)|tenho\s+(?:algo|alguma\s+coisa)\s+(?:no|na|em)|verifica[r]?\s+(?:conflitos?|disponibilidade))\b/.test(folded)
    // Phase 12 batch 66 (2026-05-16): Spanish "estoy libre"/"estoy
    // disponible" added (ES uses "estoy" with 'y', distinct from
    // PT-PT "estou" with 'u').
    || /\bestoy\s+(?:libre|disponible)\b/.test(folded);
  if (!isFreeBusyQuestion) return null;
  const calendar = parseNaturalLanguageCalendarEvent(input.text, {
    timezone: input.timezone,
    nowIso: input.nowIso ?? new Date().toISOString(),
  });
  const provider = /\b(outlook)\b/.test(folded) ? 'outlook_calendar' : 'google_calendar';
  const args: Record<string, unknown> = {
    provider,
    startDateTime: calendar?.startDateTime ?? null,
    endDateTime: calendar?.endDateTime ?? null,
  };
  const step = makeStep(input, {
    skill: 'secretary_calendar',
    action: 'check_calendar_conflicts',
    risk: 'read_only',
    provider,
    args,
    requiredArgsPresent: Boolean(args.startDateTime && args.endDateTime),
  });
  return buildPlanFromSteps(input, [step], ['check_calendar_conflicts_intent', 'deterministic_calendar_parser'], 0.78);
}

function parseBroadSkillActionIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  const locale = input.locale || 'pt-BR';
  const now = DateTime.fromISO(input.nowIso ?? new Date().toISOString()).setZone(input.timezone);

  // Phase 16 batch 89 second half (2026-05-17): score-based intent picking.
  //
  // Before this batch the dispatch was first-match priority — each parser
  // returned `step | null` and the first non-null result won. The original
  // Phase 6 batch 6 routing-gap fix established a hand-coded priority
  // ordering (notifications/decisions ahead of training because "disable
  // training notifications" should pick notifications). Score-based
  // picking preserves that ordering as scoreboard weights AND adds slot-
  // completeness as a TIE-BREAKER (small enough not to cross the
  // smallest priority gap of 0.01) so when two parsers at the same
  // base weight both match, the more-confident extraction wins.
  //
  // The score = baseWeight + (requiredArgsPresent ? bonus : 0). The
  // bonus is intentionally smaller than the smallest inter-skill priority
  // gap between adjacent skills so it only tie-breaks within a priority
  // tier; it never demotes a higher-priority skill.
  const candidates: Array<{
    step: ChatPlanStep;
    routingSignals: string[];
    confidence: number;
    score: number;
  }> = [];
  function consider(step: ChatPlanStep | null, baseWeight: number, signals: string[]) {
    if (!step) return;
    const score = baseWeight + (step.requiredArgsPresent ? BROAD_SKILL_SLOT_COMPLETENESS_BONUS : 0);
    candidates.push({ step, routingSignals: signals, confidence: baseWeight, score });
  }

  consider(parseNotificationActionStep(input, folded), 0.78, ['notification_action_intent', 'deterministic_skill_parser']);
  consider(parseDecisionActionStep(input, folded), 0.77, ['decision_action_intent', 'deterministic_skill_parser']);
  consider(parseContentActionStep(input, folded), 0.78, ['content_action_intent', 'deterministic_skill_parser']);
  consider(parseMailActionStep(input, folded), 0.77, ['mail_action_intent', 'deterministic_skill_parser']);
  consider(parseCookingActionStep(input, folded, now), 0.76, ['cooking_action_intent', 'deterministic_skill_parser']);
  consider(parseFinanceActionStep(input, folded, now), 0.75, ['finance_action_intent', 'deterministic_skill_parser']);
  consider(parseConnectionsActionStep(input, folded), 0.74, ['connections_action_intent', 'deterministic_skill_parser']);
  consider(parseTrainingActionStep(input, folded), 0.72, ['training_action_intent', 'deterministic_skill_parser']);

  if (candidates.length > 0) {
    // Stable sort: highest score wins; first declared wins on tie to
    // preserve the historic priority ordering.
    const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
    return buildPlanFromSteps(input, [best.step], best.routingSignals, best.confidence);
  }

  if (messageHasActionCandidate(input.text)) {
    const subset = selectRegistrySubsetForMessage(input.text);
    const primary = subset[0];
    if (primary) {
      const step = makeStep(input, {
        skill: primary.skill,
        action: primary.action,
        risk: primary.risk,
        provider: primary.providerDependencies[0] ?? 'nexus',
        args: { rawRequest: input.text },
        requiredArgsPresent: false,
      });
      return buildPlanFromSteps(input, [step], ['unknown_action_candidate', primary.skill], 0.42);
    }
  }
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

function buildPlanFromSteps(input: ChatPlannerInput, steps: ChatPlanStep[], routingSignals: string[], confidence: number): ChatActionPlan {
  const effectiveConfidence = calibratePlanConfidence(steps, confidence);
  const requireSafeWrites = input.requireSafeWriteConfirmation === true;
  return {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: input.nowIso ?? new Date().toISOString(),
    planner: steps.length > 1 ? 'mixed' : 'deterministic',
    steps,
    requiresConfirmation: steps.some((step) => stepRequiresConfirmation(step, { requireSafeWrites })),
    clarificationQuestion: steps.some((step) => !step.requiredArgsPresent)
      ? buildTargetedClarificationQuestion(input, steps)
      : undefined,
    clarificationReason: steps.some((step) => !step.requiredArgsPresent)
      ? 'missing_required_fields'
      : undefined,
    confidence,
    effectiveConfidence,
    telemetry: {
      routeTier: 'tier0_deterministic',
      candidates: steps.map((step) => ({ skill: step.skill, action: step.action, score: effectiveConfidence })),
      calibratedScore: effectiveConfidence,
      threshold: thresholdForSteps(steps),
      verifierStatus: steps.some((step) => step.verification.required) ? 'pending' : 'not_required',
    },
    debug: {
      routingSignals,
      rejectedFastPaths: [],
      parser: 'deterministic',
    },
  };
}

function buildNeedsInputPlan(input: ChatPlannerInput, opts: {
  skill: ChatActionSkill;
  action: ChatActionName;
  question: string;
  args: Record<string, unknown>;
  routingSignals: string[];
  clarificationReason?: ChatClarificationReason;
  intentClass?: string;
}): ChatActionPlan {
  const step = makeStep(input, {
    skill: opts.skill,
    action: opts.action,
    risk: 'ambiguous',
    provider: 'nexus',
    args: opts.args,
    requiredArgsPresent: false,
  });
  return {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: input.nowIso ?? new Date().toISOString(),
    planner: 'deterministic',
    steps: [step],
    requiresConfirmation: false,
    clarificationQuestion: opts.question,
    clarificationReason: opts.clarificationReason ?? 'missing_required_fields',
    intentClass: opts.intentClass,
    confidence: 0.72,
    effectiveConfidence: 0.72,
    telemetry: {
      routeTier: 'tier0_deterministic',
      candidates: [{ skill: opts.skill, action: opts.action, score: 0.72 }],
      calibratedScore: 0.72,
      threshold: 0.86,
      verifierStatus: 'not_required',
      outcome: 'needs_input',
    },
    debug: {
      routingSignals: opts.routingSignals,
      rejectedFastPaths: [],
      parser: 'deterministic',
    },
  };
}

function buildMessageOnlyPlan(input: ChatPlannerInput, text: string, signal: string): ChatActionPlan {
  const args = { text };
  const step: ChatPlanStep = {
    stepId: `step-${randomUUID()}`,
    skill: 'connections',
    type: 'answer',
    action: 'connections_status',
    risk: 'read_only',
    riskClass: 'R0',
    provider: 'none',
    args,
    requiredArgsPresent: true,
    idempotencyKey: buildStepIdempotencyKey(input, 'connections_status', args),
    verification: { required: false, method: 'none' },
  };
  return {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: input.nowIso ?? new Date().toISOString(),
    planner: 'deterministic',
    steps: [step],
    requiresConfirmation: false,
    confidence: 0.99,
    effectiveConfidence: 0.99,
    telemetry: {
      routeTier: 'tier0_deterministic',
      candidates: [{ skill: 'connections', action: 'connections_status', score: 0.99 }],
      calibratedScore: 0.99,
      threshold: 0.7,
      verifierStatus: 'not_required',
      outcome: signal,
    },
    debug: { routingSignals: [signal], rejectedFastPaths: [], parser: 'deterministic' },
  };
}

// makeStep, buildStepIdempotencyKey, normalizeHashArgs, isHashDateTimeKey,
// actionToStepType, and pickExpectedFields moved to src/services/skills/
// step-builder.ts on 2026-05-15 (planner-split foundation, audit
// implementation plan Phase 0). They are imported at the top of this file.

function parseSimpleTaskIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const step = parseSimpleTaskStep(input, input.text);
  if (!step) return null;
  const requireSafeWrites = input.requireSafeWriteConfirmation === true;
  return {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: input.nowIso ?? new Date().toISOString(),
    planner: 'deterministic',
    steps: [step],
    requiresConfirmation: stepRequiresConfirmation(step, { requireSafeWrites }),
    confidence: 0.82,
    debug: {
      routingSignals: ['task_write_intent', 'deterministic_task_parser'],
      rejectedFastPaths: [],
      parser: 'deterministic',
    },
  };
}

function parseSimpleTaskStep(input: ChatPlannerInput, text: string | null): ChatPlanStep | null {
  if (!text) return null;
  const folded = foldCalendarText(text);
  if (hasLegacySubtaskIntent(removeTaskQuotedSegments(text))) return null;
  // Phase 2 batch 10: PT-BR colloquial create-verbs ("bota", "coloca", "põe",
  // "mete") added so "Bota uma tarefa chamada X" routes through the simple-
  // task parser instead of falling through.
  // Phase 8 batch 43 (2026-05-15): Spanish "crea"/"crear" + "tarea" added
  // for minimum Spanish coverage.
  // Phase 9 batch 48 (2026-05-16): Spanish "añade"/"añadir" added.
  const directTaskCreate = /\b(cria|criar|adiciona|adicionar|create|add|bota[r]?|coloca[r]?|p[oõ]e[r]?|mete[r]?|crea[r]?|a[nñ]ade|a[nñ]adir|agreg[ae][r]?)\b/.test(folded)
    && /\b(task|tarefa|todo|lembrete|tarea[s]?)\b/.test(folded);
  const reminderTaskCreate = isPlainTaskReminderCreate(folded);
  if (!directTaskCreate && !reminderTaskCreate) return null;
  const titleSlot = extractTaskTitleSlot(input, text);
  const title = titleSlot?.value.trim();
  if (!title) return null;
  const dueSlot = extractTaskDueDateTimeSlot(input, text);
  // Literal-title policy (audit §10, approved 2026-05-15 by Felipe): when the
  // title span comes from an explicit title marker (called/chamada/titulo:/named/
  // quoted-string — extractTaskTitleSlot returns confidence ≥ 0.95 for those),
  // treat the title as user-provided content, even if it contains destructive
  // verbs. Outside trusted spans (heuristic fallback at confidence < 0.95),
  // the unsafe-title defense still applies.
  //
  // Prompt-injection markers (§10.1 point 4) override the literal-title policy:
  // explicit LLM-instruction syntax (`ignore previous instructions`,
  // `<|im_start|>`, `[INST]`, etc.) refuses regardless of trusted-span status.
  const fromTrustedTitleSpan = (titleSlot?.confidence ?? 0) >= 0.95;
  const hasInjectionMarker = containsPromptInjectionMarker(title);
  const destructiveOutsideTitleSpan = !fromTrustedTitleSpan && isUnsafeTaskTitle(title);
  const unsafeTitle = hasInjectionMarker || destructiveOutsideTitleSpan;
  const args = unsafeTitle
    ? { title: null, rejectedTitle: title, list: null, dueDateTime: dueSlot?.value ?? null, notes: null }
    : { title, list: null, dueDateTime: dueSlot?.value ?? null, notes: null };
  const slotProvenance: Record<string, ChatSlotProvenance> = {
    title: makeSlotProvenance({
      slot: 'title',
      value: title,
      rawText: titleSlot?.rawText ?? title,
      turnId: input.messageId,
      spanStart: titleSlot?.spanStart ?? null,
      spanEnd: titleSlot?.spanEnd ?? null,
      sourceType: 'user_message',
      normalizer: 'task_title_v2',
      confidence: titleSlot?.confidence ?? 0.9,
    }),
  };
  if (dueSlot) {
    slotProvenance.dueDateTime = makeSlotProvenance({
      slot: 'dueDateTime',
      value: dueSlot.value,
      rawText: dueSlot.rawText,
      turnId: input.messageId,
      spanStart: dueSlot.spanStart,
      spanEnd: dueSlot.spanEnd,
      sourceType: 'user_message',
      normalizer: 'task_due_datetime_v1',
      confidence: dueSlot.confidence,
    });
  }
  return {
    stepId: `step-${randomUUID()}`,
    skill: 'tasks',
    type: 'create_task',
    action: 'create_task',
    risk: unsafeTitle ? 'ambiguous' : 'safe_write',
    riskClass: unsafeTitle ? 'R4' : 'R1',
    provider: 'nexus',
    args,
    slotProvenance,
    requiredArgsPresent: !unsafeTitle,
    idempotencyKey: buildStepIdempotencyKey(input, 'create_task', args),
    verification: {
      required: true,
      method: 'local_read_back',
      expectedFields: unsafeTitle ? {} : { title },
    },
  };
}

function startsWithSimpleTaskCreateIntent(text: string): boolean {
  const folded = foldCalendarText(text).replace(/^(?:please|por favor|pfv)\s+/, '');
  return /^\s*(?:create|add|cria[r]?|adiciona[r]?|bota[r]?|coloca[r]?|poe[r]?|mete[r]?|crea[r]?|anade|anadir|agrega[r]?)\b[\s\S]{0,40}\b(?:task|tarefa|todo|lembrete|tarea)\b/.test(folded)
    || /^\s*(?:remind me to|lembra-?me de|lembre-?me de|recuerdame(?: a)?|recordarme(?: a)?)\b/.test(folded);
}

function isUnsafeTaskTitle(title: string): boolean {
  const folded = foldCalendarText(title);
  return /\b(delete|remove|erase|wipe|apaga|apagar|elimina|eliminar|remove)\b.*\b(all|todos|todas|everything|tasks|tarefas|events|eventos|emails?)\b/.test(folded)
    || /\b(send|envia|enviar)\b.*\b(all|todos|todas|emails?|mensagens)\b/.test(folded)
    || /\b(delete|apaga|apagar)\b.*\b(church|igreja|event|evento)\b/.test(folded);
}

// Audit §10.1 point 4: prompt-injection markers (LLM-instruction syntax) are
// NOT covered by the literal-title policy. These markers must refuse
// regardless of whether they appear inside a trusted title span. Distinct from
// `isUnsafeTaskTitle`, which catches destructive natural-language vocabulary.
function containsPromptInjectionMarker(title: string): boolean {
  return /\bignore\s+(?:previous|all|prior)\s+instructions?\b/i.test(title)
    || /\bignore\s+(?:all\s+)?access\s+checks?\b/i.test(title)
    || /\bbypass\s+(?:all\s+)?access\s+checks?\b/i.test(title)
    || /\benable\s+every\s+skill\b/i.test(title)
    || /\bdisregard\s+(?:previous|all|prior)\s+instructions?\b/i.test(title)
    || /\bforget\s+(?:everything|all|previous|prior)\b/i.test(title)
    || /\b(?:you\s+are\s+now|act\s+as|new\s+instructions)\b/i.test(title)
    || /<\|im_(?:start|end)\|>/i.test(title)
    || /\[\/?(?:INST|SYS|SYSTEM)\]/i.test(title)
    || /<\|(?:system|user|assistant)\|>/i.test(title)
    || /\bsystem\s+prompt\s*:/i.test(title)
    // Phase 2 batch 7 (2026-05-15): Portuguese injection markers. The same
    // refusal contract applies — these phrasings target the LLM rather than
    // describing what the user wants. Limited to forms that are unambiguous
    // attacks (i.e., not casual usage of "ignora" in everyday conversation,
    // which the trailing "instruções/regras/contexto" disambiguates).
    || /\bignor[ae]\s+(?:as\s+|todas\s+as\s+|qualquer\s+)?instru[cç][oõ]es\s+anteriores\b/i.test(title)
    || /\bdesconsiderar?\s+(?:as\s+)?instru[cç][oõ]es\s+(?:anteriores|pr[eé]vias)\b/i.test(title)
    || /\besquec[ae]\s+(?:tudo|as\s+instru[cç][oõ]es|o\s+que\s+eu\s+disse|o\s+contexto)\b/i.test(title)
    || /\bvoc[eê]\s+(?:agora\s+)?[eé]\s+(?:um\s+)?(?:admin|administrador|root)\b/i.test(title)
    || /\bnov[ao]s?\s+instru[cç][oõ]es\s*:/i.test(title)
    || /\bage?\s+como\s+(?:admin|administrador|sistema)\b/i.test(title);
}

function extractTaskTitleSlot(input: ChatPlannerInput, text: string): { value: string; rawText: string; spanStart: number; spanEnd: number; confidence: number } | null {
  const quotedTaskTitle = /\b(?:task|tarefa|todo|lembrete|tarea)\b\s*["“]([^"”]+)["”]/i.exec(text);
  if (quotedTaskTitle?.[1]) {
    const raw = quotedTaskTitle[1].trim();
    const cleaned = cleanupTaskTitle(raw, input);
    if (cleaned.length > 0) {
      const start = quotedTaskTitle.index + quotedTaskTitle[0].indexOf(quotedTaskTitle[1]);
      return { value: cleaned, rawText: raw, spanStart: start, spanEnd: start + quotedTaskTitle[1].length, confidence: 0.98 };
    }
  }

  const explicitPatterns = [
    /\b(?:called|named|titled|with\s+title|chamad[oa]|com\s+o\s+t[ií]tulo|t[ií]tulo|llamad[oa]|titulada)\s*[:\-]?\s*["“]?([\s\S]+?)["”]?(?=$|[.!?]\s*$)/i,
  ];
  for (const pattern of explicitPatterns) {
    const match = pattern.exec(text);
    const raw = match?.[1]?.trim();
    if (!match || !raw) continue;
    const cleaned = cleanupTaskTitle(raw, input);
    if (cleaned.length > 0) {
      const start = match.index + match[0].indexOf(match[1]);
      return { value: cleaned, rawText: raw, spanStart: start, spanEnd: start + match[1].length, confidence: 0.97 };
    }
  }

  const reminder = /\b(?:remind\s+me\s+to|lembra-?me\s+de|lembre-?me\s+de|recu[eé]rdame\s+(?:a\s+)?|recordarme\s+(?:a\s+)?)\b/i.exec(text);
  if (reminder) {
    const rest = text.slice(reminder.index + reminder[0].length).trim();
    const cleaned = sentenceCaseEnglishTaskTitle(cleanupTaskTitle(rest, input), input, text);
    if (cleaned.length > 0) {
      const start = text.indexOf(rest);
      return { value: cleaned, rawText: rest, spanStart: start >= 0 ? start : reminder.index, spanEnd: start >= 0 ? start + rest.length : text.length, confidence: 0.85 };
    }
  }

  const taskNoun = /\b(?:task|tarefa|todo|lembrete|tarea)\b/i.exec(text);
  if (!taskNoun) return null;
  let rest = text.slice(taskNoun.index + taskNoun[0].length).trim();
  rest = rest.replace(/^(?:to|for|para)\s+/i, '');
  rest = stripLeadingTaskTemporalPhrase(rest, input);
  let cleaned = sentenceCaseEnglishTaskTitle(cleanupTaskTitle(rest, input), input, text);
  if (cleaned.length === 0) {
    cleaned = sentenceCaseEnglishTaskTitle(extractPreTaskModifierTitle(text, taskNoun.index, input), input, text);
  }
  if (cleaned.length === 0) return null;
  const start = text.indexOf(rest);
  return { value: cleaned, rawText: rest, spanStart: start >= 0 ? start : taskNoun.index, spanEnd: start >= 0 ? start + rest.length : text.length, confidence: 0.82 };
}

function extractPreTaskModifierTitle(text: string, taskNounIndex: number, input: ChatPlannerInput): string {
  const prefix = text.slice(0, taskNounIndex)
    .replace(/^\s*(?:please|por favor|pfv)\s+/i, '')
    .replace(/^\s*(?:create|add|cria[r]?|adiciona[r]?|bota[r]?|coloca[r]?|p[oõ]e[r]?|mete[r]?|crea[r]?|a[nñ]ade|a[nñ]adir|agreg[ae][r]?)\s+/i, '')
    .replace(/^\s*(?:a|an|uma?|una?)\s+/i, '')
    .trim();
  const cleaned = cleanupTaskTitle(prefix, input);
  return /^(?:new|nova?|nuevo|nueva)$/i.test(cleaned) ? '' : cleaned;
}

function isPlainTaskReminderCreate(folded: string): boolean {
  if (!/\b(remind me to|lembra-?me de|lembre-?me de|recuerdame(?: a)?|recordarme(?: a)?)\b/.test(folded)) return false;
  return !/\b(credit card|cartao|cartao de credito|fatura|factura|bill|invoice|darf|irs|iva|tax|imposto|stripe|payment|pagamento)\b/.test(folded);
}

function sentenceCaseEnglishTaskTitle(title: string, input: ChatPlannerInput, sourceText: string): string {
  if (!title) return title;
  const isEnglish = input.locale?.toLowerCase().startsWith('en') === true
    || /^\s*(?:add|create|remind me to)\b/i.test(sourceText);
  if (!isEnglish || !/^[a-z]/.test(title)) return title;
  return `${title[0]?.toUpperCase() ?? ''}${title.slice(1)}`;
}

function cleanupTaskTitle(title: string, input: ChatPlannerInput): string {
  let cleaned = title.trim()
    .replace(/^["“]|["”]$/g, '')
    .replace(/[.?!]+$/g, '')
    .trim();
  cleaned = stripTaskTemporalPhrase(cleaned, input).trim();
  cleaned = cleaned
    .replace(/\s+(?:tomorrow|amanh[ãa]|today|hoje)(?:\s+(?:at|[àa]s?|as|pelas?|by|para\s+as?)\s*)?(?:\d{1,2}h(?:\d{2})?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*$/i, '')
    .trim();
  cleaned = cleaned
    .replace(/\s+\b(?:please|por favor)\b$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned;
}

function stripLeadingTaskTemporalPhrase(text: string, input: ChatPlannerInput): string {
  const folded = foldCalendarText(text);
  if (!/^(today|tomorrow|amanha|amanhã|hoje|next|proxim[ao]|próxim[ao]|\d{1,2}[\/-]\d{1,2})\b/.test(folded)) return text;
  return text
    .replace(/^(?:today|tomorrow|amanh[ãa]|hoje)(?:\s+(?:at|às?|as|pelas?)\s*)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}h(?:\d{2})?)?\s*/i, '')
    .replace(/^(?:next|pr[oó]xim[ao])\s+\w+\s*/i, '')
    .trim();
}

function stripTaskTemporalPhrase(title: string, input: ChatPlannerInput): string {
  const due = extractTaskDueDateTimeSlot(input, title);
  if (!due) return title;
  return `${title.slice(0, due.spanStart)} ${title.slice(due.spanEnd)}`.replace(/\s{2,}/g, ' ').trim();
}

function extractTaskDueDateTimeSlot(input: ChatPlannerInput, text: string): { value: string; rawText: string; spanStart: number; spanEnd: number; confidence: number } | null {
  const now = DateTime.fromISO(input.nowIso ?? new Date().toISOString()).setZone(input.timezone);
  const patterns = [
    /\b(?:for|para|due|vence|pra|p[ao]ra)?\s*(?<date>tomorrow|amanh[ãa]|today|hoje)(?=\s|$|[,.!?])\s+(?:at|às?|as|pelas?|by|para\s+as)?\s*(?<time>\d{1,2}h(?:\d{2})?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i,
    /\b(?<date>tomorrow|amanh[ãa]|today|hoje)(?=\s|$|[,.!?])(?:\s+(?:at|às?|as|pelas?|by|para)\s*)?(?<time>\d{1,2}h(?:\d{2})?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i,
    /\b(?:for|para|due|vence|pra|p[ao]ra)\s+(?<date>tomorrow|amanh[ãa]|today|hoje)(?=\s|$|[,.!?])(?:\s+(?:at|às?|as|pelas?)\s*)?(?<time>\d{1,2}h(?:\d{2})?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i,
    /\b(?:for|on|by|due|para|pra|p[ao]ra|el|na|no)?\s*(?<date>monday|tuesday|wednesday|thursday|friday|saturday|sunday|segunda(?:-feira)?|ter[cç]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[aá]bado|domingo|lunes|martes|mi[eé]rcoles|jueves|viernes)\b(?:\s+(?:at|às?|as|a\s+las|pelas?|by|para\s+as)\s*)?(?<time>\d{1,2}h(?:\d{2})?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i,
    /\b(?:at|às?|as|pelas?)\s*(?<time>\d{1,2}h(?:\d{2})?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.groups) continue;
    const raw = match[0];
    const dateWord = foldCalendarText(String(match.groups.date || ''));
    let date = resolveTaskDueDate(now, dateWord);
    if (!dateWord && /\b(?:at|às?|as|pelas?)\b/i.test(raw)) date = now;
    const parsedTime = parseTaskClockTime(match.groups.time || '');
    if (!parsedTime && !dateWord) continue;
    const value = parsedTime
      ? date.set({
        hour: parsedTime.hour,
        minute: parsedTime.minute,
        second: 0,
        millisecond: 0,
      }).toISO()
      : date.toISODate();
    if (!value) continue;
    return {
      value,
      rawText: raw.trim(),
      spanStart: match.index,
      spanEnd: match.index + raw.length,
      confidence: dateWord ? 0.94 : 0.78,
    };
  }
  return null;
}

function resolveTaskDueDate(now: DateTime, dateWord: string): DateTime {
  if (dateWord === 'tomorrow' || dateWord === 'amanha' || dateWord === 'manana') return now.plus({ days: 1 });
  const weekday = taskWeekdayNumber(dateWord);
  if (!weekday) return now;
  let days = weekday - now.weekday;
  if (days <= 0) days += 7;
  return now.plus({ days });
}

function taskWeekdayNumber(dateWord: string): number | null {
  switch (dateWord) {
    case 'monday':
    case 'segunda':
    case 'segunda-feira':
    case 'lunes':
      return 1;
    case 'tuesday':
    case 'terca':
    case 'terca-feira':
    case 'martes':
      return 2;
    case 'wednesday':
    case 'quarta':
    case 'quarta-feira':
    case 'miercoles':
      return 3;
    case 'thursday':
    case 'quinta':
    case 'quinta-feira':
    case 'jueves':
      return 4;
    case 'friday':
    case 'sexta':
    case 'sexta-feira':
    case 'viernes':
      return 5;
    case 'saturday':
    case 'sabado':
      return 6;
    case 'sunday':
    case 'domingo':
      return 7;
    default:
      return null;
  }
}

function parseTaskClockTime(rawInput: unknown): { hour: number; minute: number } | null {
  const raw = String(rawInput || '').trim().toLowerCase();
  const match = raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/) || raw.match(/\b(\d{1,2})h(\d{2})?\b/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3];
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

function extractTaskClause(text: string): string | null {
  const match = text.match(/\b(?:e|and)\s+(?=(?:cria|criar|adiciona|adicionar|create|add)\b[\s\S]*\b(?:tarefa|task|todo|lembrete)\b)([\s\S]+)$/i);
  return match?.[1]?.trim() || null;
}

function buildClarificationPlan(input: ChatPlannerInput, question: string): ChatActionPlan {
  return {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: input.nowIso ?? new Date().toISOString(),
    planner: 'deterministic',
    steps: [{
      stepId: `step-${randomUUID()}`,
      skill: 'secretary_calendar',
      type: 'clarification',
      action: 'schedule_event',
      risk: 'ambiguous',
      riskClass: 'R4',
      provider: 'none',
      args: {},
      requiredArgsPresent: false,
      idempotencyKey: buildStepIdempotencyKey(input, 'schedule_event', { text: input.text }),
      verification: { required: false, method: 'none' },
    }],
    requiresConfirmation: false,
    clarificationQuestion: question,
    clarificationReason: 'ambiguous_intent',
    intentClass: 'clarifying_question',
    confidence: 0.4,
  };
}

function clarificationReasonForPlan(plan: ChatActionPlan): ChatClarificationReason {
  if (plan.clarificationReason) return plan.clarificationReason;
  if (plan.telemetry && plan.effectiveConfidence != null && plan.effectiveConfidence < plan.telemetry.threshold) {
    return 'low_confidence';
  }
  return 'missing_required_fields';
}

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

function multiStepType(plan: ChatActionPlan, fallback: string): string {
  return plan.steps.length > 1 ? 'chat_action_multi_step_result' : fallback;
}

function multiStepMetadata(plan: ChatActionPlan, results: ChatStepExecutionResult[]): Record<string, unknown> {
  if (plan.steps.length <= 1) return {};
  return { multiStepSummary: buildMultiStepSummary(plan, results) };
}

function rowToConfirmedStep(row: ChatActionRunRow): ChatPlanStep | null {
  const action = row.action_type as ChatActionName;
  const registryEntry = getChatActionRegistry().find((entry) => entry.action === action);
  if (!registryEntry) return null;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(row.request_json || '{}') as Record<string, unknown>;
  } catch {
    return null;
  }
  const provider = normalizeProvider(row.provider ?? args.provider) ?? registryEntry.providerDependencies[0] ?? 'nexus';
  return {
    stepId: `confirmed-${row.id}`,
    skill: registryEntry.skill,
    type: actionToStepType(action),
    action,
    risk: row.risk,
    riskClass: riskClassForRisk(row.risk),
    provider,
    args,
    requiredArgsPresent: registryEntry.requiredFields.every((field) => args[field] != null && args[field] !== ''),
    idempotencyKey: row.normalized_action_hash,
    verification: {
      required: registryEntry.verifier !== 'none',
      method: registryEntry.verifier,
      expectedFields: pickExpectedFields(args, registryEntry.requiredFields),
    },
  };
}

function persistPlanStatus(plan: ChatActionPlan, input: ChatPlannerInput, status: ChatActionRunStatus): void {
  if (input.persistRuns === false) return;
  for (const step of plan.steps) {
    persistStepStatus(plan, input, step, status);
  }
}

function persistStepStatus(
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  step: ChatPlanStep,
  status: ChatActionRunStatus,
): void {
  if (input.persistRuns === false) return;
  if (status === 'needs_clarification' && step.action === 'training_plan_create') {
    const args = step.args as Record<string, unknown>;
    upsertPendingChatAction({
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      skill: 'training',
      action: 'training_plan_create',
      collectedSlots: args,
      missingSlots: missingTrainingPlanSlots(args),
      riskClass: 'R1',
      locale: input.locale || plan.locale,
      timezone: input.timezone,
      originatingSurface: input.channel,
      nowIso: plan.createdAt,
    });
  }
  const claim = claimChatActionRun({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    normalizedActionHash: step.idempotencyKey,
    provider: step.provider,
    actionType: step.action,
    risk: step.risk,
    request: step.args,
    nowIso: plan.createdAt,
  });
  const accepted = updateChatActionRun(claim.row.id, status, {
    error: status === 'needs_clarification' ? { reason: 'missing_required_fields' } : undefined,
    verification: status === 'needs_confirmation' ? { required: true, reason: 'risk_policy' } : undefined,
  });
  if (!accepted) {
    logger.warn({
      runId: claim.row.id,
      userId: input.userId,
      tenantId: input.tenantId,
      attemptedStatus: status,
    }, 'chat action plan status update rejected by terminal run state');
  }
}

function buildActionResponse(
  input: ChatPlannerInput,
  plan: ChatActionPlan,
  status: ChatActionStatus,
  text: string,
  metadata: Record<string, unknown>,
): ChatActionRouteResponse {
  const responseTelemetry = finalizeTelemetryForResponse(plan, status, metadata, input);
  if (input.persistRuns !== false) {
    const firstStep = plan.steps[0];
    try {
      recordChatActionTelemetry({
        userId: input.userId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        planner: plan.planner,
        status,
        skill: firstStep?.skill ?? null,
        action: firstStep?.action ?? null,
        telemetry: responseTelemetry,
        nowIso: input.nowIso,
      });
    } catch (err) {
      logger.debug({
        err,
        userId: input.userId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        messageId: input.messageId,
      }, 'chat action telemetry record skipped');
    }
  }

  // Phase 16 batch 84 (2026-05-17): emit responseBlocks alongside `text`.
  // Builds typed blocks from the producer's existing markdown/prose so
  // iOS can render natively instead of falling back to MarkdownRenderer
  // (the bleed-asterisk path). The legacy `text` field stays for older
  // iOS builds + Telegram/WhatsApp adapters during the rollout window.
  // Phase 16 batch 86 (2026-05-17): emit responseCards for the three
  // currently-typed card kinds (refusal, clarification, confirmation)
  // when the metadata indicates them. Card payloads come from the
  // existing metadata fields — no new server-side state.
  const responseBlocks = buildBlocksFromMarkdown(text);
  const responseCards = buildResponseCardsFromMetadata(metadata);

  return {
    id: `msg-${Date.now()}-${randomUUID().slice(0, 8)}`,
    text,
    domain: domainForPlan(plan),
    routeMethod: `chat-action-${plan.planner}`,
    confidence: plan.confidence,
    buttons: null,
    metadata: {
      ...metadata,
      schemaVersion: 1,
      // Phase 16 batch 80 (2026-05-16): callers may provide a more specific
      // actionStatus (e.g. 'refused') that should NOT be overwritten by the
      // persisted ChatActionStatus (e.g. 'blocked'). Honor caller-provided
      // metadata.actionStatus when present; fall back to the persisted status
      // otherwise. The persisted status keeps DB schema compatibility.
      actionStatus: (typeof metadata.actionStatus === 'string' && metadata.actionStatus.length > 0) ? metadata.actionStatus : status,
      actionPlanner: plan.planner,
      effectiveConfidence: plan.effectiveConfidence ?? plan.confidence,
      telemetry: safeTelemetry(responseTelemetry),
      involvedSkills: [...new Set(plan.steps.map((step) => step.skill))],
      // Developer trace is persisted server-side through action runs/logs; normal UI gets only this safe summary.
    },
    timestamp: new Date().toISOString(),
    responseBlocks,
    responseCards,
  };
}

// Phase 16 batch 86 (2026-05-17): derive typed responseCards from
// existing metadata. Refusal / clarification / confirmation are the
// three card kinds emitted at the action-planner boundary today; the
// remaining 12 kinds in ChatResponseCardKind are populated by their
// dedicated executors (calendar agenda, task creation, etc.) — those
// extend this function as block-builder migration lands in Batches 84+.
function buildResponseCardsFromMetadata(metadata: Record<string, unknown>): ChatResponseCard[] | undefined {
  const cards: ChatResponseCard[] = [];
  const refusal = metadata.refusal as { reason?: string; message?: string } | undefined;
  if (refusal && typeof refusal.message === 'string') {
    cards.push({
      kind: 'refusalCard',
      reason: typeof refusal.reason === 'string' ? refusal.reason : 'unknown',
      message: refusal.message,
    });
  }
  const clarification = metadata.clarification as { question?: string; reason?: string } | undefined;
  if (clarification && typeof clarification.question === 'string') {
    cards.push({
      kind: 'clarificationCard',
      question: clarification.question,
      reason: clarification.reason === 'missing_required_fields'
        || clarification.reason === 'ambiguous_intent'
        || clarification.reason === 'low_confidence'
        ? clarification.reason
        : undefined,
    });
  }
  const confirmation = metadata.actionConfirmation as { title?: string; message?: string; destructive?: boolean } | undefined;
  if (confirmation && typeof confirmation.message === 'string' && typeof confirmation.title === 'string') {
    cards.push({
      kind: 'confirmationCard',
      title: confirmation.title,
      message: confirmation.message,
      destructive: Boolean(confirmation.destructive),
    });
  }
  return cards.length > 0 ? cards : undefined;
}

function requeuePartialSuccessPendingParents(
  input: ChatPlannerInput,
  plan: ChatActionPlan,
  results: Array<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }>,
): void {
  if (input.persistRuns === false) return;
  for (const result of results) {
    if (result.status !== 'partial_success') continue;
    try {
      markPendingChatActionNeedsUserFollowup({
        userId: input.userId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        skill: result.step.skill,
        action: result.step.action,
        nowIso: plan.createdAt,
      });
    } catch (err) {
      logger.debug({
        err,
        userId: input.userId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        skill: result.step.skill,
        action: result.step.action,
      }, 'chat action pending parent requeue skipped');
    }
  }
}

// actionToStepType and pickExpectedFields moved to skills/step-builder.ts.

function buildCalendarSlotProvenance(input: ChatPlannerInput, calendar: NonNullable<ReturnType<typeof parseNaturalLanguageCalendarEvent>>, provider: ChatProvider): Record<string, ChatSlotProvenance> {
  const rawText = input.text;
  return {
    title: makeSlotProvenance({ slot: 'title', value: calendar.title, rawText, turnId: input.messageId, normalizer: 'calendar_nlp_v1', confidence: calendar.confidence }),
    provider: makeSlotProvenance({ slot: 'provider', value: provider, rawText, turnId: input.messageId, normalizer: 'calendar_provider_alias_v1', confidence: 0.98 }),
    startDateTime: makeSlotProvenance({ slot: 'startDateTime', value: calendar.startDateTime, rawText, turnId: input.messageId, normalizer: 'calendar_nlp_v1', confidence: calendar.confidence }),
    endDateTime: makeSlotProvenance({ slot: 'endDateTime', value: calendar.endDateTime, rawText, turnId: input.messageId, normalizer: 'calendar_nlp_v1', confidence: calendar.confidence }),
    timezone: makeSlotProvenance({ slot: 'timezone', value: calendar.timezone, rawText: null, turnId: input.messageId, sourceType: 'safe_default', normalizer: 'user_timezone', confidence: 1 }),
  };
}
