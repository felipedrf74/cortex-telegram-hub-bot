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
} from './unified-calendar';
import { isGoogleCalendarConfigured } from './google-calendar';
import { isOutlookCalendarConfigured } from './outlook-calendar';
import {
  parseNaturalLanguageCalendarEvent,
  hasCalendarWriteIntent,
  hasCalendarReadIntent,
  hasMailReadIntent,
  foldCalendarText,
} from './calendar-natural-language-parser';
import {
  findChatActionDefinition,
  getChatActionRegistry,
  messageHasActionCandidate,
  riskClassForRisk,
  runSlotValidators,
  selectRegistrySubsetForMessage,
  type SlotValidationResult,
  type ChatActionName,
  type ChatActionDefinition,
  type ChatActionRisk,
  type ChatActionSkill,
  type ChatProvider,
} from './chat-action-registry';
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
} from './chat/types';
import {
  buildNormalizedActionHash,
  claimChatActionRun,
  claimChatActionRunForExecution,
  listPendingChatActionRuns,
  updateChatActionRun,
  type ChatActionRunRow,
  type ChatActionRunStatus,
} from './chat-action-run-store';
import {
  cancelPendingChatActions,
  getActivePendingChatAction,
  makeSlotProvenance,
  markPendingChatActionNeedsUserFollowup,
  recordChatActionTelemetry,
  rememberRecentChatEntity,
  resolveRecentChatEntity,
  upsertPendingChatAction,
  type ChatActionRiskClass,
  type ChatActionTelemetry,
  type ChatSlotProvenance,
} from './chat-action-state';
import { buildLlmSafePromptSlice } from './build-llm-safe-prompt-slice';
import { redactSensitivePromptText } from './llm-prompt-safety';
import {
  getCurrentChatToolAuthorizationContext,
  runWithChatToolAuthorization,
} from './chat-tool-authorization';
import {
  buildBlocksFromMarkdown,
} from './chat-response-blocks';
import type { ChatResponseCard } from './chat-response-cards';
import {
  actionToStepType,
  buildStepIdempotencyKey,
  makeStep,
  pickExpectedFields,
} from './skills/step-builder';
import { parseConnectionsActionStep } from './skills/connections/parser';
import { parseContentActionStep } from './skills/content/parser';
import { parseCookingActionStep } from './skills/cooking/parser';
import { parseDecisionActionStep } from './skills/decision_center/parser';
import { parseFinanceActionStep } from './skills/finance/parser';
import { parseMailActionStep } from './skills/mail/parser';
import { parseNotificationActionStep } from './skills/notifications/parser';
import { hasPastTenseSignal } from './skills/past-tense-detector';
import { extractTopic, inferContentPlatform, inferProviderName } from './skills/text-extractors';
import {
  extractTrainingPlanSlots,
  extractWeeklyVolumeKm,
  makeTrainingPlanStep,
  missingTrainingPlanSlots,
  TRAINING_PLAN_REQUIRED_SLOTS,
} from './skills/training/helpers';
import { parseTrainingActionStep } from './skills/training/parser';
import { invalidateCalendarCaches } from './cache-coherence-registry';
import { getTaskProviderForUser } from './task-store/task-router';
import { resolveTaskCreationList } from './task-store/task-list-resolution';
import { completeOneShot, isGeminiProviderConfigured } from './gemini-provider';
import { computeModelUsageCostUsd } from './model-pricing';
import {
  buildContentAgencyPackage,
  getContentAgencyProject,
  handoffContentAgencyPackageToPipeline,
  persistContentAgencyArtifact,
} from './content-agency';
import { addTopic, getTopicById } from './content-scheduler';
import { generateShoppingList, getMealPlan, getShoppingList, setMealPlan } from './cooking-chef';
import {
  getMonthlySummary,
  getPreferredCurrencyForUser,
  formatCurrencyAmount,
  getTaxEvents,
  markTaxPaid,
  updateTransactionCategory,
} from './finance-tracker';
import { getIntegrationSummary } from './integration-status';
import { getActivePlanSummary, getPlanById, getSessionById } from './training-plans';
import {
  confirmTrainingSessionReflow,
  previewTrainingSessionReflow,
} from '../api/routes/training-plan-calendar-sync';
import { getUnreadMailSummaryForUser } from './unified-mail-pressure';
import { searchEmailsForUser as searchGmailEmailsForUser } from './google-gmail';
import { searchEmailsForUser as searchOutlookEmailsForUser } from './outlook-mail';
import {
  createNotificationIntent,
  getOrCreateNotificationProfile,
  updateNotificationProfile,
} from './notification-orchestrator';
import {
  dismissDecision,
  getDecisionItem,
  performDecisionAction,
  snoozeDecision,
} from './decision-center';
import { logger } from '../utils/logger';
import {
  getChatHybridPlannerMode,
  isChatEscalationReviewerEnabled,
  isChatLlmTier1Enabled,
  isChatLlmTier2Enabled,
  isChatOpenSurfaceHandoffEnabled,
} from './runtime-flags';

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
} from './chat/types';

const CHAT_LLM_TIER2_GEMINI_MODEL = 'gemini-2.5-flash';
const CHAT_LLM_TIER2_OPENAI_FALLBACK_MODEL = 'gpt-5.4-nano';
const CHAT_LLM_TIER1_GEMINI_MODEL = 'gemini-2.5-flash-lite';
const CHAT_LLM_TIER3_GEMINI_MODEL = 'gemini-2.5-flash';
const CHAT_LLM_TIER3_OPENAI_FALLBACK_MODEL = 'gpt-5.4-mini';
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

function hasLegacySubtaskIntent(text: string): boolean {
  const folded = foldCalendarText(text);
  return /\b(sub\s*-?\s*tasks?|subtarefas?|check\s*-?\s*list|checklist|lista de verificacao)\b/.test(folded);
}

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
  if (!hasCalendarWriteIntent(text) && hasLegacySubtaskIntent(text)) {
    return false;
  }
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

  const pendingContinuation = buildPendingSlotContinuationPlan(input);
  if (pendingContinuation) return pendingContinuation;
  // Phase 7 close-out (2026-05-15): cooking pending-meal-plan continuation.
  // Mirrors the training-plan continuation: when the user has a pending
  // cooking_meal_plan and the new turn supplies dietary constraints
  // ("high-protein, vegetarian", "low-carb, no fish"), apply them as
  // additional args and re-emit the plan step.
  const cookingPendingContinuation = buildPendingCookingMealPlanContinuation(input);
  if (cookingPendingContinuation) return cookingPendingContinuation;
  // Phase 8 batch 38 (2026-05-15): mail draft refinement continuation.
  const mailPendingContinuation = buildPendingMailDraftContinuation(input);
  if (mailPendingContinuation) return mailPendingContinuation;
  // Phase 8 batch 38: decision_choose with sub-options continuation.
  const decisionPendingContinuation = buildPendingDecisionChooseContinuation(input);
  if (decisionPendingContinuation) return decisionPendingContinuation;
  // Phase 8 batch 38: finance categorize-receipt category continuation.
  const financePendingContinuation = buildPendingFinanceCategorizeContinuation(input);
  if (financePendingContinuation) return financePendingContinuation;
  // Phase 9 batch 44 (2026-05-16): content brief / script-create pending
  // continuation. Turn 1 invokes the brief / script intent; turn 2 supplies
  // additional spec (audience, platform-specific tone, length target).
  const contentPendingContinuation = buildPendingContentSpecContinuation(input);
  if (contentPendingContinuation) return contentPendingContinuation;

  const recentFollowUp = buildRecentEntityFollowUpPlan(input);
  if (recentFollowUp) return recentFollowUp;

  const ambiguousAction = buildAmbiguousActionClarificationPlan(input);
  if (ambiguousAction) return ambiguousAction;

  if (!shouldRunActionPlannerBeforeReadOnlyFastPaths(input.text)) return null;

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

// Phase 9 batch 44 (2026-05-16): content brief / script-create pending
// continuation. When a pending content brief or script-create action is
// active, treat the next user turn as additional spec — audience, tone,
// length, format, hook style — and re-emit the action with the spec
// applied. Mirrors the cooking/mail/decision/finance continuation pattern.
function buildPendingContentSpecContinuation(input: ChatPlannerInput): ChatActionPlan | null {
  const pending = getActivePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'content',
    nowIso: input.nowIso,
  });
  if (!pending) return null;
  if (pending.action !== 'content_brief_create' && pending.action !== 'content_script_create') {
    return null;
  }
  const folded = foldCalendarText(input.text);
  // Recognise content-spec vocabulary: audience tokens, tone adjectives,
  // length targets, format hints. Includes EN + PT phrasings.
  const specPattern = /\b(audience|tone|length|hook|short|long|brief|punchy|inspirational|educational|tutorial|comedic|professional|casual|formal|under\s+\d+\s+(?:seconds?|words?|minutes?)|\d+\s+(?:seconds?|words?|minutes?)|pubico|p[uú]blico|tom|gancho|curto|longo|inspirador|educacional|tutorial|coloquial|profissional|abaixo\s+de\s+\d+|menos\s+de\s+\d+)\b/i;
  if (!specPattern.test(folded)) return null;
  const specs = (folded.match(new RegExp(specPattern.source, 'gi')) ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter((s, idx, arr) => arr.indexOf(s) === idx)
    .slice(0, 8);
  const collected = { ...pending.collectedSlots, specs };
  const step = makeStep(input, {
    skill: 'content',
    action: pending.action,
    risk: 'safe_write',
    provider: 'nexus',
    args: collected,
    requiredArgsPresent: true,
  });
  return buildPlanFromSteps(
    input,
    [step],
    [`pending_content_${pending.action}_spec_fill`, `specs:${specs.length}`],
    0.9,
  );
}

// Phase 8 batch 38 (2026-05-15): mail draft refinement continuation.
// When a pending draft_email action is active and the user provides
// refinement directives ("shorter", "friendlier", "include the timeline"),
// apply them as refinement instructions and re-emit the draft action.
function buildPendingMailDraftContinuation(input: ChatPlannerInput): ChatActionPlan | null {
  const pending = getActivePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'mail',
    nowIso: input.nowIso,
  });
  if (!pending || pending.action !== 'draft_email') return null;
  const folded = foldCalendarText(input.text);
  // Recognise refinement directives: tone (friendlier, shorter, formal),
  // content additions ("include the timeline", "mention the discount"),
  // style edits (bullet points, line breaks).
  // Phase 10 batch 52 (2026-05-16): Spanish refinement directives.
  // ES uses "más" (with accent) where PT uses "mais"; "amistoso/a"
  // replaces "amigável"; "incluye"/"añade"/"quita" cover include/add/
  // remove verbs. Adjectives are gender-inflected (corto/corta, etc.).
  const refinementPattern = /\b(shorter|longer|friendlier|formal|casual|punchier|tighter|crisper|softer|include\s+\w+|mention\s+\w+|add\s+\w+|remove\s+\w+|bullet\s+points|line\s+breaks|mais\s+(?:curto|longo|formal|amig[aá]vel|direto)|m[aá]s\s+(?:cort[oa]|larg[oa]|formal|amistos[oa]|direct[oa]|breve|simple)|incluir?\s+\w+|incluy[ae]\s+\w+|menciona[r]?\s+\w+|adiciona[r]?\s+\w+|a[nñ]ade\s+\w+|quita\s+\w+|elimina\s+\w+)\b/i;
  if (!refinementPattern.test(folded)) return null;
  const refinements = (folded.match(new RegExp(refinementPattern.source, 'gi')) ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter((s, idx, arr) => arr.indexOf(s) === idx)
    .slice(0, 8);
  const collected = { ...pending.collectedSlots, refinements };
  const step = makeStep(input, {
    skill: 'mail',
    action: 'draft_email',
    risk: 'safe_write',
    provider: 'gmail',
    args: collected,
    requiredArgsPresent: true,
  });
  return buildPlanFromSteps(
    input,
    [step],
    ['pending_mail_draft_refinement', `refinements:${refinements.length}`],
    0.9,
  );
}

// Phase 8 batch 38: decision_choose with sub-options continuation.
// When a pending decision_choose is active and the user provides a choice
// ("A", "option B", "vou de C"), apply as the choice arg.
function buildPendingDecisionChooseContinuation(input: ChatPlannerInput): ChatActionPlan | null {
  const pending = getActivePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'decision_center',
    nowIso: input.nowIso,
  });
  if (!pending || pending.action !== 'decision_choose') return null;
  // Recognise standalone choice tokens: "A", "B", "Option C", "opção 2",
  // "vou de B", "go with A".
  // Phase 10 batch 52 (2026-05-16): Spanish "Opción B" / "elijo C" /
  // "me quedo con A" / "voy con D" added.
  const choiceMatch =
    input.text.match(/\b(?:option|op[cç][aã]o|opci[oó]n)\s+([a-zA-Z0-9]+)/i)
    || input.text.match(/\b(?:vou\s+de|go\s+with|i'?ll\s+go\s+with|let'?s\s+go\s+with|pick|choose|escolho|elijo|voy\s+con|me\s+quedo\s+con)\s+(?:option\s+|opci[oó]n\s+|la\s+|el\s+)?([a-zA-Z0-9]+)/i)
    || input.text.match(/^\s*([A-D]|\d)\s*[.!]?\s*$/i);
  if (!choiceMatch?.[1]) return null;
  const choice = choiceMatch[1].toUpperCase();
  const collected = { ...pending.collectedSlots, choice };
  const step = makeStep(input, {
    skill: 'decision_center',
    action: 'decision_choose',
    risk: 'safe_write',
    provider: 'nexus',
    args: collected,
    requiredArgsPresent: true,
  });
  return buildPlanFromSteps(
    input,
    [step],
    ['pending_decision_choose_slot_fill', `choice:${choice}`],
    0.92,
  );
}

// Phase 8 batch 38: finance categorize-receipt category continuation.
// When a pending finance_categorize_receipt is active and the user supplies
// the category in a short follow-up ("office supplies", "travel", "meals"),
// apply as the category arg.
function buildPendingFinanceCategorizeContinuation(input: ChatPlannerInput): ChatActionPlan | null {
  const pending = getActivePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'finance',
    nowIso: input.nowIso,
  });
  if (!pending || pending.action !== 'finance_categorize_receipt') return null;
  // Recognise short category replies (1–4 words) common in receipt
  // categorization. The category vocabulary intentionally biases toward
  // business-expense buckets used in Stripe / accounting tooling.
  const folded = foldCalendarText(input.text);
  const categoryPattern = /\b(office\s+supplies?|travel|meals?\s*(?:and\s+entertainment)?|transportation|software|hardware|marketing|advertising|professional\s+services?|utilities|rent|insurance|equipment|subscriptions?|training|education|material(?:\s+de\s+escrit[oó]rio)?|despesas?\s+de\s+(?:viagem|escrit[oó]rio|transporte|marketing)|alimenta[cç][aã]o|transporte|softwares?|publicidade|servi[cç]os?\s+profissionais|materiais?|formaca[ao]|treinamento)\b/i;
  const match = folded.match(categoryPattern);
  if (!match) return null;
  // Use the first matched category as the canonical value (lowercased).
  const category = match[0].toLowerCase().trim();
  const collected = { ...pending.collectedSlots, category };
  const step = makeStep(input, {
    skill: 'finance',
    action: 'finance_categorize_receipt',
    risk: 'safe_write',
    provider: 'nexus',
    args: collected,
    requiredArgsPresent: Boolean((collected as Record<string, unknown>).receiptId),
  });
  return buildPlanFromSteps(
    input,
    [step],
    ['pending_finance_categorize_receipt_slot_fill', `category:${category}`],
    0.9,
  );
}

// Phase 7 close-out (2026-05-15): cooking pending-meal-plan continuation.
// When a pending cooking_meal_plan action is active, treat the next user
// turn as dietary constraints / preferences and re-emit the action with
// those constraints applied.
function buildPendingCookingMealPlanContinuation(input: ChatPlannerInput): ChatActionPlan | null {
  const pending = getActivePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'cooking',
    nowIso: input.nowIso,
  });
  if (!pending) return null;
  // Extract dietary-constraint signals from the user text. Pattern includes
  // common diet preferences ("vegetarian", "vegan", "high-protein", "keto",
  // "low-carb", "no fish", "gluten-free") plus PT-BR/PT-PT equivalents
  // ("vegetariano", "rico em proteína", "sem peixe", "sem glúten").
  const folded = foldCalendarText(input.text);
  // Phase 10 batch 52 (2026-05-16): Spanish dietary constraints — ES uses
  // gender-inflected adjectives (vegetariana/vegetariano, vegana/vegano),
  // "alta/alto en proteína" for high-protein, "bajo en carbohidratos",
  // and "sin <food>" for exclusions.
  const constraintPattern = /\b(vegetarian|vegan|high[\s-]?protein|low[\s-]?carb|keto|paleo|mediterranean|mediterr[aá]nea?|whole30|gluten[\s-]?free|dairy[\s-]?free|nut[\s-]?free|no\s+(?:fish|pork|beef|red\s+meat|dairy|gluten|sugar|carbs?)|vegetarian[oa]|vegan[oa]|rico\s+em\s+prote[ií]na|alt[oa]\s+en\s+prote[ií]na|baixo\s+em\s+carbo|baj[oa]\s+en\s+carbo|sem\s+(?:peixe|carne|gluten|glúten|laticínios?|lactose|açúcar)|sin\s+(?:pescado|carne|gluten|gl[uú]ten|l[aá]cteos?|lactosa|az[uú]car))\b/i;
  if (!constraintPattern.test(folded)) return null;
  const constraints = (folded.match(new RegExp(constraintPattern.source, 'gi')) ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter((s, idx, arr) => arr.indexOf(s) === idx)
    .slice(0, 8);
  const collected = { ...pending.collectedSlots, constraints };
  const step = makeStep(input, {
    skill: 'cooking',
    action: 'cooking_meal_plan',
    risk: 'safe_write',
    provider: 'nexus',
    args: collected,
    requiredArgsPresent: true,
  });
  return buildPlanFromSteps(
    input,
    [step],
    ['pending_cooking_meal_plan_continuation', `constraints:${constraints.length}`],
    0.9,
  );
}

function buildPendingSlotContinuationPlan(input: ChatPlannerInput): ChatActionPlan | null {
  const pending = getActivePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'training',
    nowIso: input.nowIso,
  });
  const weeklyVolume = extractWeeklyVolumeKm(input.text);

  if (!pending) {
    if (weeklyVolume == null) return null;
    return buildNeedsInputPlan(input, {
      skill: 'training',
      action: 'training_plan_create',
      question: input.locale?.startsWith('pt')
        ? 'Posso usar esse volume semanal num plano de treino. Estás a criar ou ajustar um plano?'
        : 'I can use that weekly volume for a training plan. Are we creating or adjusting a plan?',
      args: { weeklyVolumeKm: weeklyVolume },
      routingSignals: ['standalone_training_slot_without_pending_action'],
    });
  }

  const collected = { ...pending.collectedSlots };
  const provenance: Record<string, ChatSlotProvenance> = {};
  if (weeklyVolume != null && pending.missingSlots.includes('weeklyVolumeKm')) {
    collected.weeklyVolumeKm = weeklyVolume;
    provenance.weeklyVolumeKm = makeSlotProvenance({
      slot: 'weeklyVolumeKm',
      value: weeklyVolume,
      rawText: input.text,
      turnId: input.messageId,
      sourceType: 'user_message',
      normalizer: 'training_weekly_volume_v1',
      confidence: 0.96,
    });
  }

  const extracted = extractTrainingPlanSlots(input);
  for (const [slot, value] of Object.entries(extracted.slots)) {
    if (value == null || value === '') continue;
    if (!pending.missingSlots.includes(slot) && collected[slot] != null) continue;
    collected[slot] = value;
    provenance[slot] = extracted.provenance[slot];
  }

  if (Object.keys(provenance).length === 0) {
    return buildNeedsInputPlan(input, {
      skill: 'training',
      action: 'training_plan_create',
      question: buildTargetedClarificationQuestion(input, [makeTrainingPlanStep(input, pending.collectedSlots, pending.missingSlots, {})]),
      args: pending.collectedSlots,
      routingSignals: ['pending_training_action_unmatched_answer'],
    });
  }

  const missing = missingTrainingPlanSlots(collected);
  const step = makeTrainingPlanStep(input, collected, missing, provenance);
  return buildPlanFromSteps(input, [step], ['pending_training_plan_slot_fill', ...Object.keys(provenance).map((slot) => `slot:${slot}`)], missing.length === 0 ? 0.94 : 0.88);
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

  // Phase 1 batch 4 (2026-05-15): create_checklist runs BEFORE the legacy
  // subtask guard. The legacy guard was written when the planner had no
  // checklist parser and "checklist" intents needed to fall back to a higher
  // tier; now that we own the intent deterministically, we claim it first.
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
  const args: Record<string, unknown> = { date: 'today' };
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

const FORBIDDEN_MODEL_ARG_KEYS = new Set([
  'userid',
  'uid',
  'user',
  'tenantid',
  'tenant',
  'accountid',
  'account',
  'owneruserid',
  'ownerid',
  'owner',
  'proto',
  'prototype',
  'constructor',
  'customerid',
  'subjectid',
  'principalid',
  'memberid',
  'actorid',
  'providertoken',
  'provideraccesstoken',
  'providerrefreshtoken',
  'accesstoken',
  'refreshtoken',
  'oauthtoken',
  'oauthcredentials',
  'oauthcredential',
  'clientsecret',
  'apikey',
  'rawsystemprompt',
  'systemprompt',
  'developerprompt',
  'internalprompt',
  'systeminstructions',
  'reasoning',
  'internalreasoning',
  'debug',
  'debugcard',
  'debugcards',
  'internaldebug',
  'internaldebugcard',
  'nexusanswer',
  'structuredresponse',
  'rawmodeloutput',
  'modeltrace',
  'tooltrace',
]);

function sanitizePlannerArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizePlannerArgValue(args);
  return isRecord(sanitized) ? sanitized : {};
}

function sanitizePlannerArgValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePlannerArgValue(item));
  }
  if (typeof value === 'string') return redactSensitivePromptText(value);
  if (!isRecord(value)) return value;

  const sanitized = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenModelArgKey(key)) continue;
    sanitized[key] = sanitizePlannerArgValue(child);
  }
  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isForbiddenModelArgKey(key: string): boolean {
  return FORBIDDEN_MODEL_ARG_KEYS.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase());
}

function missingRequiredFieldsForStep(step: ChatPlanStep): string[] {
  const definition = findChatActionDefinition(step.skill, step.action);
  const requiredFields = definition?.requiredFields ?? [];
  return requiredFields.filter((field) => step.args[field] == null || step.args[field] === '');
}

function buildTargetedClarificationQuestion(input: ChatPlannerInput, steps: ChatPlanStep[]): string {
  const step = steps.find((candidate) => missingRequiredFieldsForStep(candidate).length > 0);
  if (!step) return defaultClarification(input);
  const missing = missingRequiredFieldsForStep(step);
  const pt = input.locale?.startsWith('pt');
  if (step.action === 'complete_task' && (missing.includes('taskId') || missing.includes('listId'))) {
    return pt ? 'Qual tarefa devo concluir?' : 'Which task should I mark done?';
  }
  if (missing.length === 1) {
    return targetedFieldQuestion(step, missing[0], pt);
  }
  const labels = missing.map((field) => fieldLabel(field, pt)).join(pt ? ', ' : ', ');
  if (pt) {
    return `Preciso só destes detalhes antes de executar com segurança: ${labels}.`;
  }
  return `I need these details before I can do this safely: ${labels}.`;
}

function targetedFieldQuestion(step: ChatPlanStep, field: string, pt?: boolean): string {
  const event = step.action === 'schedule_event' || step.action === 'update_event' || step.action === 'move_event';
  const task = step.skill === 'tasks';
  if (pt) {
    switch (field) {
      case 'title':
        return event ? 'Qual é o título do evento?' : task ? 'Qual é o título da tarefa?' : 'Qual é o título?';
      case 'startDateTime':
        return event ? 'Quando começa o evento?' : 'Quando começa?';
      case 'endDateTime':
        return event ? 'Quando termina o evento?' : 'Quando termina?';
      case 'timezone':
        return 'Qual é o fuso horário?';
      case 'provider':
        return 'Em que serviço devo fazer isso?';
      case 'dueDate':
      case 'dueDateTime':
        return 'Qual é a data limite?';
      case 'recipient':
        return 'Para quem devo enviar?';
      case 'subject':
        return 'Qual é o assunto?';
      case 'body':
        return 'Qual é a mensagem?';
      case 'decisionId':
        return 'Qual é a decisão?';
      case 'sessionId':
        return 'Qual é a sessão de treino?';
      case 'sport':
        return 'Qual modalidade deve orientar o plano de treino?';
      case 'goal':
        return 'Qual é o objetivo principal do plano de treino?';
      case 'durationWeeks':
        return 'Quantas semanas deve durar o plano?';
      case 'startDate':
        return 'Quando queres começar o plano?';
      case 'weeklyVolumeKm':
        return 'Quantos quilómetros por semana estás a fazer agora?';
      case 'receiptId':
        return 'Qual recibo ou transação devo usar?';
      case 'category':
        return 'Qual é a categoria?';
      case 'packageId':
        return 'Qual pacote de content devo usar?';
      default:
        return `Preciso só deste detalhe: ${fieldLabel(field, true)}.`;
    }
  }
  switch (field) {
    case 'title':
      return event ? 'What is the event title?' : task ? 'What is the task title?' : 'What title should I use?';
    case 'startDateTime':
      return event ? 'When does the event start?' : 'When should it start?';
    case 'endDateTime':
      return event ? 'When does the event end?' : 'When should it end?';
    case 'timezone':
      return 'Which timezone should I use?';
    case 'provider':
      return 'Which service should I use?';
    case 'dueDate':
    case 'dueDateTime':
      return 'What is the due date?';
    case 'recipient':
      return 'Who should I send it to?';
    case 'subject':
      return 'What subject should I use?';
    case 'body':
      return 'What message should I send?';
    case 'decisionId':
      return 'Which decision should I use?';
    case 'sessionId':
      return 'Which training session should I use?';
    case 'sport':
      return 'Which sport should the training plan focus on?';
    case 'goal':
      return 'What is the main goal for the training plan?';
    case 'durationWeeks':
      return 'How many weeks should the plan last?';
    case 'startDate':
      return 'When should the plan start?';
    case 'weeklyVolumeKm':
      return 'What is your current weekly mileage in km?';
    case 'receiptId':
      return 'Which receipt or transaction should I use?';
    case 'category':
      return 'Which category should I use?';
    case 'packageId':
      return 'Which content package should I use?';
    default:
      return `I need this detail: ${fieldLabel(field, false)}.`;
  }
}

function fieldLabel(field: string, pt?: boolean): string {
  const labels: Record<string, [string, string]> = {
    title: ['título', 'title'],
    startDateTime: ['data/hora de início', 'start date/time'],
    endDateTime: ['data/hora de fim', 'end date/time'],
    timezone: ['fuso horário', 'timezone'],
    provider: ['serviço', 'service'],
    eventId: ['evento', 'event'],
    changedFields: ['alteração pretendida', 'change to make'],
    dueDate: ['data limite', 'due date'],
    dueDateTime: ['data/hora limite', 'due date/time'],
    recipient: ['destinatário', 'recipient'],
    subject: ['assunto', 'subject'],
    body: ['mensagem', 'message'],
    decisionId: ['decisão', 'decision'],
    sessionId: ['sessão de treino', 'training session'],
    sport: ['modalidade', 'sport'],
    goal: ['objetivo', 'goal'],
    durationWeeks: ['duração em semanas', 'duration in weeks'],
    startDate: ['data de início', 'start date'],
    weeklyVolumeKm: ['volume semanal em km', 'weekly mileage in km'],
    receiptId: ['recibo ou transação', 'receipt or transaction'],
    category: ['categoria', 'category'],
    packageId: ['pacote de content', 'content package'],
    date: ['data', 'date'],
    mealType: ['refeição', 'meal'],
    weekStart: ['semana', 'week'],
    month: ['mês', 'month'],
    action: ['ação', 'action'],
    amount: ['valor', 'amount'],
  };
  const pair = labels[field];
  if (!pair) return field;
  return pt ? pair[0] : pair[1];
}

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
  if (hasLegacySubtaskIntent(text)) return null;
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

export function buildLlmPlannerPrompt(input: ChatPlannerInput): { systemPrompt: string; userPrompt: string } {
  const subset = selectRegistrySubsetForMessage(input.text);
  const candidateRegistry = subset.length > 0 ? subset : getChatActionRegistry().filter((entry) => entry.skill === 'tasks' || entry.skill === 'secretary_calendar');
  const registry = limitLlmPlannerRegistryForPrompt(input.text, candidateRegistry);
  const examples = retrievePlannerExamples(input, registry).slice(0, 6);
  // SECURITY: registry entries are filtered through buildLlmSafePromptSlice so
  // executor/verifier dispatch keys, raw R0-R4 risk codes, uiSurfaces, version,
  // status, owner, priority, slotExtractors, slotValidators, responseCardType,
  // privacyPolicy, latencyBudgetMs, fallbackPolicy, supportedCards, and any
  // prompt_injection/adversarial examples never reach LLM context. See
  // `__tests__/services/chat-action-prompt-safety.test.ts` for the contract.
  const safeRegistryView = registry.map(buildLlmSafePromptSlice);
  return {
    systemPrompt: [
      'You convert Nexus chat messages into a compact JSON action plan proposal.',
      'Return JSON only. Do not execute anything. Do not invent userId, tenantId, provider objects, or success.',
      'Allowed output types: action_plan, needs_input, needs_confirmation, open_surface, ambiguous_reference, unsupported, blocked_by_policy, no_action_chat_response.',
      'Use only these actions and required fields. Mark missing fields explicitly.',
      JSON.stringify(safeRegistryView),
      examples.length > 0 ? `Relevant examples: ${JSON.stringify(examples)}` : '',
    ].join('\n'),
    userPrompt: JSON.stringify({
      text: redactSensitivePromptText(input.text),
      locale: input.locale || 'pt-BR',
      timezone: input.timezone,
      now: input.nowIso ?? new Date().toISOString(),
      expectedShape: {
        outputType: 'action_plan',
        steps: [{ skill: 'tasks', action: 'create_task', args: {}, missingFields: [], confidence: 0.0 }],
        confidence: 0.0,
      },
    }),
  };
}

const MAX_LLM_PLANNER_REGISTRY_ACTIONS = 11;

function limitLlmPlannerRegistryForPrompt(
  text: string,
  registry: ChatActionDefinition[],
): ChatActionDefinition[] {
  if (registry.length <= MAX_LLM_PLANNER_REGISTRY_ACTIONS) return registry;
  const folded = foldCalendarText(text);
  const ranked = registry
    .map((entry, index) => ({
      entry,
      index,
      key: `${entry.skill}.${entry.action}`,
      score: scoreRegistryEntryForPrompt(folded, entry),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = new Map<string, ChatActionDefinition>();
  const bySkill = new Map<ChatActionSkill, typeof ranked>();
  for (const item of ranked) {
    const bucket = bySkill.get(item.entry.skill) ?? [];
    bucket.push(item);
    bySkill.set(item.entry.skill, bucket);
  }
  for (const items of bySkill.values()) {
    if (selected.size >= MAX_LLM_PLANNER_REGISTRY_ACTIONS) break;
    selected.set(items[0].key, items[0].entry);
  }
  for (const item of ranked) {
    if (selected.size >= MAX_LLM_PLANNER_REGISTRY_ACTIONS) break;
    selected.set(item.key, item.entry);
  }
  return [...selected.values()];
}

function scoreRegistryEntryForPrompt(foldedText: string, entry: ChatActionDefinition): number {
  let score = 0;
  const actionTokens = entry.action.split('_').filter((token) => token.length >= 3);
  const skillTokens = entry.skill.split('_').filter((token) => token.length >= 3);
  for (const token of [...actionTokens, ...skillTokens]) {
    if (foldedText.includes(token)) score += 2;
  }
  for (const intent of entry.readableIntents) {
    const foldedIntent = foldCalendarText(intent);
    if (foldedText.includes(foldedIntent)) score += 4;
    for (const token of foldedIntent.split(/\s+/).filter((part) => part.length >= 4)) {
      if (foldedText.includes(token)) score += 1;
    }
  }
  for (const field of [...entry.requiredFields, ...entry.optionalFields]) {
    const foldedField = field.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    if (foldedText.includes(foldedField)) score += 1;
  }
  return score;
}

export function buildTier1ClassifierPrompt(input: ChatPlannerInput): { systemPrompt: string; userPrompt: string } {
  const subset = selectRegistrySubsetForMessage(input.text);
  // Tier 1 deliberately suppresses high-risk actions (destructive/financial/
  // admin_security) — that filter runs on the raw `risk` field BEFORE mapping
  // to the safe view, since the safe view exposes only a coarse riskLabel.
  const registry = (subset.length > 0 ? subset : getChatActionRegistry())
    .filter((entry) => entry.risk !== 'destructive' && entry.risk !== 'financial' && entry.risk !== 'admin_security')
    .slice(0, 8);
  const examples = retrievePlannerExamples(input, registry).slice(0, 4);
  const safeRegistryView = registry.map(buildLlmSafePromptSlice);
  return {
    systemPrompt: [
      'Classify a Nexus chat message into the smallest likely skill/action candidate set.',
      'Return JSON only. Do not execute anything. Do not invent trusted IDs or claim success.',
      'Use Tier 1 only for simple routing and slot hints. Complex/multistep messages may return needsTier2=true.',
      JSON.stringify(safeRegistryView),
      examples.length > 0 ? `Relevant examples: ${JSON.stringify(examples)}` : '',
    ].join('\n'),
    userPrompt: JSON.stringify({
      text: redactSensitivePromptText(input.text),
      locale: input.locale || 'pt-BR',
      timezone: input.timezone,
      now: input.nowIso ?? new Date().toISOString(),
      expectedShape: {
        candidates: [{ skill: 'tasks', action: 'create_task', score: 0.0, args: {}, missingFields: [] }],
        needsTier2: false,
      },
    }),
  };
}

function parsePlannerJsonObject(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (!fence) return null;
    try { return JSON.parse(fence[1]); } catch { return null; }
  }
}

type PlannerJsonParseOptions = {
  routeTier?: ChatActionTelemetry['routeTier'];
  routingSignal?: string;
};

export function parseLlmPlannerJson(raw: string, input: ChatPlannerInput, options: PlannerJsonParseOptions = {}): ChatActionPlan | null {
  const parsed = parsePlannerJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
  const steps: ChatPlanStep[] = [];
  for (const candidate of parsed.steps.slice(0, 5)) {
    const skill = candidate.skill as ChatActionSkill;
    const action = candidate.action as ChatActionName;
    const definition = findChatActionDefinition(skill, action);
    if (!definition) return null;
    const args = sanitizePlannerArgs(typeof candidate.args === 'object' && candidate.args ? candidate.args as Record<string, unknown> : {});
    const modelMissing = Array.isArray(candidate.missingFields)
      ? candidate.missingFields.filter((field: unknown): field is string => typeof field === 'string')
      : [];
    const validation = runSlotValidators(definition, args, {
      locale: input.locale,
      timezone: input.timezone,
      nowIso: input.nowIso,
    });
    const invalidFields = Object.keys(validation.errors ?? {});
    const missing = [...new Set([
      ...modelMissing,
      ...(validation.missing ?? []),
      ...invalidFields,
    ])];
    const risk = definition.risk;
    const slotProvenance = buildLlmSlotProvenance(input, args, definition.requiredFields, provenanceSourceForRouteTier(options.routeTier), validation);
    steps.push({
      stepId: `step-${randomUUID()}`,
      skill,
      type: actionToStepType(action),
      action,
      risk,
      riskClass: riskClassForRisk(risk),
      provider: normalizeProvider(args.provider),
      args,
      slotProvenance,
      requiredArgsPresent: missing.length === 0 && validation.ok,
      idempotencyKey: buildStepIdempotencyKey(input, action, args),
      verification: {
        required: definition.verifier !== 'none',
        method: definition.verifier,
        expectedFields: pickExpectedFields(args, definition.requiredFields),
      },
    });
  }
  const requiresConfirmation = steps.some((step) => stepRequiresConfirmation(step, {
    requireSafeWrites: input.requireSafeWriteConfirmation === true,
  }));
  const confidence = clampConfidence(Number(parsed.confidence ?? Math.min(...steps.map((step) => step.requiredArgsPresent ? 0.72 : 0.45))));
  const effectiveConfidence = calibratePlanConfidence(steps, confidence);
  const threshold = thresholdForSteps(steps);
  const belowCalibratedThreshold = effectiveConfidence < threshold;
  const needsClarification = steps.some((step) => !step.requiredArgsPresent) || belowCalibratedThreshold;
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
    planner: 'llm_structured',
    steps,
    requiresConfirmation,
    clarificationQuestion: needsClarification ? buildTargetedClarificationQuestion(input, steps) : undefined,
    confidence,
    effectiveConfidence,
    telemetry: {
      routeTier: options.routeTier ?? 'tier2_structured_planner',
      candidates: steps.map((step) => ({ skill: step.skill, action: step.action, score: effectiveConfidence })),
      calibratedScore: effectiveConfidence,
      threshold,
      verifierStatus: steps.some((step) => step.verification.required) ? 'pending' : 'not_required',
      failureReason: belowCalibratedThreshold ? 'below_calibrated_threshold' : undefined,
    },
    debug: {
      routingSignals: [options.routingSignal ?? 'llm_structured_planner'],
      rejectedFastPaths: [],
      parser: 'model_assisted',
    },
  };
}

export function parseTier1ClassifierJson(raw: string, input: ChatPlannerInput): ChatActionPlan | null {
  const parsed = parsePlannerJsonObject(raw);
  if (!parsed || parsed.needsTier2 === true || !Array.isArray(parsed.candidates) || parsed.candidates.length === 0) return null;
  const sorted = parsed.candidates
    .filter((candidate: any) => candidate && typeof candidate.skill === 'string' && typeof candidate.action === 'string')
    .sort((a: any, b: any) => Number(b.score ?? 0) - Number(a.score ?? 0));
  const top = sorted[0];
  if (!top || Number(top.score ?? 0) < 0.72) return null;
  const draft = {
    confidence: Number(top.score ?? parsed.confidence ?? 0.72),
    steps: [{
      skill: top.skill,
      action: top.action,
      args: typeof top.args === 'object' && top.args ? top.args : {},
      missingFields: Array.isArray(top.missingFields) ? top.missingFields : undefined,
    }],
  };
  const plan = parseLlmPlannerJson(JSON.stringify(draft), input, {
    routeTier: 'tier1_classifier',
    routingSignal: 'tier1_classifier_slot_helper',
  });
  if (!plan) return null;
  const threshold = plan.telemetry?.threshold ?? thresholdForSteps(plan.steps);
  if (plan.steps.every((step) => step.requiredArgsPresent) && (plan.effectiveConfidence ?? plan.confidence) < threshold) {
    return null;
  }
  if (plan.telemetry) {
    plan.telemetry.candidates = sorted.slice(0, 3).map((candidate: any) => ({
      skill: candidate.skill,
      action: candidate.action,
      score: clampConfidence(Number(candidate.score ?? 0)),
    })).filter((candidate: any) => Boolean(findChatActionDefinition(candidate.skill, candidate.action)));
  }
  return plan;
}

async function tryBuildLlmStructuredPlan(input: ChatPlannerInput): Promise<ChatActionPlan | null> {
  if (!isChatLlmTier2Enabled(process.env, { userId: input.userId, tenantId: input.tenantId })) return null;
  const prompt = buildLlmPlannerPrompt(input);
  try {
    const result = await completeStructuredPlannerWithCascade(prompt, input);
    const plan = parseLlmPlannerJson(result.text, input);
    if (plan?.debug) plan.debug.modelProvider = result.provider;
    if (plan?.telemetry) {
      plan.telemetry.modelProvider = result.provider;
      plan.telemetry.model = result.model;
      plan.telemetry.estimatedTokenCostUsd = estimatePlannerCallCostUsd(result.provider, result.model, prompt.systemPrompt, prompt.userPrompt, result.text);
    }
    return plan;
  } catch (err) {
    logger.debug({ err, userId: input.userId, tenantId: input.tenantId }, 'chat action llm structured planner unavailable');
    return null;
  }
}

async function tryBuildTier1ClassifierPlan(input: ChatPlannerInput): Promise<ChatActionPlan | null> {
  if (!isChatLlmTier1Enabled(process.env, { userId: input.userId, tenantId: input.tenantId })) return null;
  const prompt = buildTier1ClassifierPrompt(input);
  try {
    if (!isGeminiProviderConfigured()) return null;
    const text = await completeOneShot(
      prompt.systemPrompt,
      prompt.userPrompt,
      'chat_action_tier1_classifier',
      {
        model: CHAT_LLM_TIER1_GEMINI_MODEL,
        temperature: 0,
        maxTokens: 450,
        jsonMode: true,
        userId: input.userId,
        tenantId: input.tenantId,
        timeoutMs: 1800,
      },
    );
    const plan = parseTier1ClassifierJson(text, input);
    if (plan?.debug) plan.debug.modelProvider = 'gemini';
    if (plan?.telemetry) {
      plan.telemetry.modelProvider = 'gemini';
      plan.telemetry.model = CHAT_LLM_TIER1_GEMINI_MODEL;
      plan.telemetry.estimatedTokenCostUsd = estimatePlannerCallCostUsd('gemini', CHAT_LLM_TIER1_GEMINI_MODEL, prompt.systemPrompt, prompt.userPrompt, text);
    }
    return plan;
  } catch (err) {
    logger.debug({ err, userId: input.userId, tenantId: input.tenantId }, 'chat action tier1 classifier unavailable');
    return null;
  }
}

async function tryBuildEscalationReviewerPlan(input: ChatPlannerInput): Promise<ChatActionPlan | null> {
  if (!isChatEscalationReviewerEnabled(process.env, { userId: input.userId, tenantId: input.tenantId })) return null;
  const basePrompt = buildLlmPlannerPrompt(input);
  const prompt = {
    systemPrompt: [
      basePrompt.systemPrompt,
      'Escalation reviewer mode: only return a plan when the request is supported, semantically clear, and safer than asking a clarification. Otherwise return unsupported or needs_input.',
      'Never approve destructive, financial, admin, or external-side-effect execution without confirmation.',
    ].join('\n'),
    userPrompt: basePrompt.userPrompt,
  };
  try {
    const result = await completeEscalationReviewerWithCascade(prompt, input);
    const plan = parseLlmPlannerJson(result.text, input, {
      routeTier: 'tier3_reviewer',
      routingSignal: 'tier3_escalation_reviewer',
    });
    if (plan?.debug) plan.debug.modelProvider = result.provider;
    if (plan?.telemetry) {
      plan.telemetry.modelProvider = result.provider;
      plan.telemetry.model = result.model;
      plan.telemetry.estimatedTokenCostUsd = estimatePlannerCallCostUsd(result.provider, result.model, prompt.systemPrompt, prompt.userPrompt, result.text);
    }
    return plan;
  } catch (err) {
    logger.debug({ err, userId: input.userId, tenantId: input.tenantId }, 'chat action escalation reviewer unavailable');
    return null;
  }
}

async function completeStructuredPlannerWithCascade(
  prompt: { systemPrompt: string; userPrompt: string },
  input: ChatPlannerInput,
): Promise<{ text: string; provider: 'gemini' | 'openai'; model: string }> {
  if (isGeminiProviderConfigured()) {
    try {
      const text = await completeOneShot(
        prompt.systemPrompt,
        prompt.userPrompt,
        'chat_action_planner',
        {
          model: CHAT_LLM_TIER2_GEMINI_MODEL,
          temperature: 0,
          maxTokens: 900,
          jsonMode: true,
          userId: input.userId,
          tenantId: input.tenantId,
          timeoutMs: 3500,
        },
      );
      return { text, provider: 'gemini', model: CHAT_LLM_TIER2_GEMINI_MODEL };
    } catch (err) {
      logger.warn({ err, userId: input.userId, tenantId: input.tenantId }, 'Gemini chat action planner failed, trying OpenAI nano fallback');
    }
  }

  const openai = require('./openai-provider') as typeof import('./openai-provider');
  if (!openai.isOpenAIConfigured()) {
    throw new Error('chat action planner OpenAI fallback not configured');
  }
  const text = await openai.completeOneShot(
    prompt.systemPrompt,
    prompt.userPrompt,
    'chat_action_planner_openai_fallback',
    {
      model: CHAT_LLM_TIER2_OPENAI_FALLBACK_MODEL,
      temperature: 0,
      maxTokens: 900,
      jsonMode: true,
      userId: input.userId,
      tenantId: input.tenantId,
      timeoutMs: 3500,
    },
  );
  return { text, provider: 'openai', model: CHAT_LLM_TIER2_OPENAI_FALLBACK_MODEL };
}

async function completeEscalationReviewerWithCascade(
  prompt: { systemPrompt: string; userPrompt: string },
  input: ChatPlannerInput,
): Promise<{ text: string; provider: 'gemini' | 'openai'; model: string }> {
  if (isGeminiProviderConfigured()) {
    try {
      const text = await completeOneShot(
        prompt.systemPrompt,
        prompt.userPrompt,
        'chat_action_escalation_reviewer',
        {
          model: CHAT_LLM_TIER3_GEMINI_MODEL,
          temperature: 0,
          maxTokens: 900,
          jsonMode: true,
          userId: input.userId,
          tenantId: input.tenantId,
          timeoutMs: 4500,
        },
      );
      return { text, provider: 'gemini', model: CHAT_LLM_TIER3_GEMINI_MODEL };
    } catch (err) {
      logger.warn({ err, userId: input.userId, tenantId: input.tenantId }, 'Gemini chat action reviewer failed, trying OpenAI mini fallback');
    }
  }

  const openai = require('./openai-provider') as typeof import('./openai-provider');
  if (!openai.isOpenAIConfigured()) {
    throw new Error('chat action escalation reviewer OpenAI fallback not configured');
  }
  const text = await openai.completeOneShot(
    prompt.systemPrompt,
    prompt.userPrompt,
    'chat_action_escalation_openai_fallback',
    {
      model: CHAT_LLM_TIER3_OPENAI_FALLBACK_MODEL,
      temperature: 0,
      maxTokens: 900,
      jsonMode: true,
      userId: input.userId,
      tenantId: input.tenantId,
      timeoutMs: 4500,
    },
  );
  return { text, provider: 'openai', model: CHAT_LLM_TIER3_OPENAI_FALLBACK_MODEL };
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
  if (plan.clarificationQuestion || plan.steps.some((step) => !step.requiredArgsPresent)) {
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
      type: 'chat_action_needs_input',
      actionStatus: 'needs_clarification',
      intentClass: plan.intentClass ?? (clarificationReason === 'ambiguous_intent' ? 'clarifying_question' : undefined),
      clarification: { question, reason: clarificationReason },
      openSurface: openSurfacePayloadForStep(plan.steps[0], null, input),
    });
  }

  if (plan.requiresConfirmation && options.confirmed !== true) {
    persistPlanStatus(plan, input, 'needs_confirmation');
    return buildActionResponse(input, plan, 'needs_confirmation', confirmationCopy(plan, input), {
      type: 'chat_action_needs_confirmation',
      actionStatus: 'needs_confirmation',
      actionConfirmation: {
        title: input.locale?.startsWith('pt') ? 'Confirmação necessária' : 'Confirmation needed',
        message: confirmationCopy(plan, input),
        destructive: plan.steps.some((step) => step.risk === 'destructive'),
        variant: confirmationVariant(plan),
        requiresStrongConfirm: plan.steps.some((step) => step.risk === 'financial' || step.risk === 'admin_security'),
        intentClass: intentClassForPlan(plan),
      },
    });
  }

  const results: ChatStepExecutionResult[] = [];
  for (const step of plan.steps) {
    if (step.type === 'answer') {
      results.push({ step, status: 'verified_success', result: { text: String((step.args as any).text || '') } });
      continue;
    }
    if (step.dependsOnStepIds?.some((dep) => results.some((result) => result.step.stepId === dep && result.status !== 'verified_success'))) {
      results.push({ step, status: 'blocked', error: 'dependency_failed' });
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
    if (step.action === 'schedule_event') {
      results.push(await executeCalendarCreateStep(step, plan, input, deps.calendar, input.persistRuns !== false, options.confirmed === true));
      continue;
    }
    if (step.action === 'update_event' || step.action === 'move_event') {
      results.push(await executeCalendarUpdateStep(step, plan, input, input.persistRuns !== false));
      continue;
    }
    if (step.action === 'delete_event') {
      results.push(await executeCalendarDeleteStep(step, plan, input, input.persistRuns !== false));
      continue;
    }
    if (step.action === 'check_calendar_conflicts' || step.action === 'summarize_agenda') {
      results.push(await executeCalendarReadOnlyStep(step, input, deps.calendar));
      continue;
    }
    if (step.action === 'mail_unread_count') {
      results.push(await executeMailUnreadCountStep(step, input));
      continue;
    }
    if (step.action === 'mail_inbox_summary') {
      results.push(await executeMailInboxSummaryStep(step, input));
      continue;
    }
    if (step.action === 'create_task') {
      results.push(await executeTaskCreateStep(step, plan, input, deps.taskProviderForUser, input.persistRuns !== false));
      continue;
    }
    if (step.action === 'update_task'
      || step.action === 'complete_task'
      || step.action === 'delete_task'
      || step.action === 'create_checklist'
      || step.action === 'set_task_reminder') {
      results.push(await executeTaskMutationStep(step, plan, input, deps.taskProviderForUser, input.persistRuns !== false));
      continue;
    }
    if (step.action === 'content_brief_create' || step.action === 'content_script_create' || step.action === 'content_rewrite') {
      results.push(executeContentAgencyStep(step, plan, input, input.persistRuns !== false));
      continue;
    }
    if (step.action === 'content_schedule_work') {
      results.push(executeContentScheduleWorkStep(step, plan, input, input.persistRuns !== false));
      continue;
    }
    if (step.action === 'content_pipeline_handoff') {
      results.push(executeContentPipelineHandoffStep(step, plan, input, input.persistRuns !== false));
      continue;
    }
    if (step.action === 'cooking_grocery_list') {
      results.push(executeCookingGroceryListStep(step, plan, input, input.persistRuns !== false));
      continue;
    }
    if (step.action === 'cooking_meal_plan') {
      results.push(executeCookingMealPlanStep(step, plan, input, input.persistRuns !== false));
      continue;
    }
    if (step.action === 'cooking_meal_support' || step.action === 'cooking_fueling_support') {
      results.push(executeCookingSupportStep(step, input));
      continue;
    }
    if (step.action === 'finance_summary') {
      results.push(executeFinanceSummaryStep(step, input));
      continue;
    }
    if (step.action === 'finance_create_reminder') {
      results.push(await executeFinanceReminderStep(step, plan, input, deps.taskProviderForUser, input.persistRuns !== false));
      continue;
    }
    if (step.action === 'finance_categorize_receipt') {
      results.push(executeFinanceCategorizeReceiptStep(step, plan, input, input.persistRuns !== false));
      continue;
    }
    if (step.action === 'finance_payment_action') {
      results.push(executeFinancePaymentActionStep(step, plan, input, input.persistRuns !== false));
      continue;
    }
    if (step.action === 'connections_status') {
      results.push(executeConnectionsStatusStep(step, input));
      continue;
    }
    if (step.action === 'connections_reconnect_guidance') {
      results.push(executeConnectionsReconnectGuidanceStep(step, input));
      continue;
    }
    if (step.action === 'training_coach_report') {
      results.push(executeTrainingCoachReportStep(step, input));
      continue;
    }
    if (step.action === 'training_explain_session') {
      results.push(executeTrainingExplainSessionStep(step, input));
      continue;
    }
    if (step.action === 'training_plan_create') {
      results.push(executeTrainingPlanCreateStep(step, plan, input, input.persistRuns !== false));
      continue;
    }
    if (step.action === 'training_reflow_preview' || step.action === 'training_reflow_confirm') {
      results.push(await executeTrainingReflowStep(step, plan, input, input.persistRuns !== false, options.confirmed === true));
      continue;
    }
    if (step.action === 'notification_explain') {
      results.push(executeNotificationExplainStep(step, input));
      continue;
    }
    if (step.action === 'notification_update_preference' || step.action === 'notification_create_intent') {
      results.push(await executeNotificationMutationStep(step, plan, input, input.persistRuns !== false));
      continue;
    }
    if (step.action === 'decision_choose' || step.action === 'decision_dismiss' || step.action === 'decision_snooze' || step.action === 'decision_follow_up') {
      results.push(await executeDecisionCenterStep(step, plan, input, input.persistRuns !== false));
      continue;
    }
    results.push({ step, status: 'blocked', error: unsupportedChatExecutorReason(step) });
    break;
  }

  requeuePartialSuccessPendingParents(input, plan, results);

  const needsConfirmation = results.find((result) => result.status === 'needs_confirmation');
  if (needsConfirmation) {
    persistPlanStatus(plan, input, 'needs_confirmation');
    return buildActionResponse(input, plan, 'needs_confirmation', confirmationCopy(plan, input), {
      type: 'chat_action_needs_confirmation',
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
    });
  }
  const failed = results.find((result) => result.status === 'failed' || result.status === 'blocked');
  const partial = results.some((result) => result.status !== 'verified_success');
  if (failed) {
    return buildActionResponse(input, plan, failed.status, failureCopy(input, failed.error), {
      type: failed.status === 'blocked' ? 'chat_action_blocked' : 'chat_action_failed',
      actionStatus: failed.status,
      error: { message: failureCopy(input, failed.error), retryable: failed.status !== 'blocked' },
      actionResults: sanitizeActionResults(results),
    });
  }
  const verifiedPending = results.find((result) => result.status === 'verified_pending');
  if (verifiedPending) {
    return buildActionResponse(input, plan, 'verified_pending', verifiedPendingCopy(input, verifiedPending), {
      type: 'chat_action_verified_pending',
      actionStatus: 'verified_pending',
      verificationStatus: 'verified_pending',
      openSurface: openSurfacePayloadForStep(verifiedPending.step, verifiedPending.result, input),
      actionResults: sanitizeActionResults(results),
    });
  }
  if (partial) {
    return buildActionResponse(input, plan, 'partial_success', partialCopy(input), {
      type: 'chat_action_partial_success',
      actionStatus: 'partial_success',
      actionResults: sanitizeActionResults(results),
    });
  }
  return buildActionResponse(input, plan, 'verified_success', successCopy(input, results), {
    type: 'chat_action_verified_success',
    actionStatus: 'verified_success',
    verificationStatus: 'verified_success',
    title: firstTitle(results),
    calendar: calendarCardEvents(results),
    ...resultCardPayload(results),
    actions: actionButtonsForResults(results),
    actionResults: sanitizeActionResults(results),
  });
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
}

type ClaimedActionRun = ReturnType<typeof claimChatActionRunForExecution>;

function updateClaimedActionRun(
  claim: ClaimedActionRun | null,
  status: ChatActionRunStatus,
  update?: Parameters<typeof updateChatActionRun>[2],
): boolean {
  if (!claim) return true;
  const row = updateChatActionRun(claim.row.id, status, update);
  return row !== null;
}

function reconciliationPendingResult(step: ChatPlanStep, attemptedStatus: ChatActionRunStatus): ChatStepExecutionResult {
  return {
    step,
    status: 'verified_pending',
    error: 'action_run_reconciliation_pending',
    result: {
      verified: false,
      attemptedStatus,
      reason: 'terminal_run_state_rejected_late_update',
    },
    runUpdateAccepted: false,
  };
}

function replayDuplicateClaimedActionRun(claim: ClaimedActionRun | null, step: ChatPlanStep): ChatStepExecutionResult | null {
  if (!claim || claim.acquired) return null;
  const row = claim.row;
  const result = parseStoredRunResult(row);
  if (row.status === 'verified_success') {
    return { step, status: 'verified_success', result };
  }
  if (row.status === 'partial_success') {
    return { step, status: 'partial_success', result, error: 'idempotent_retry_existing_partial_success' };
  }
  if (row.status === 'verified_pending') {
    return { step, status: 'verified_pending', result, error: 'idempotent_retry_existing_verified_pending' };
  }
  if (row.status === 'failed' || row.status === 'blocked') {
    return { step, status: row.status, result, error: `idempotent_retry_existing_${row.status}` };
  }
  if (row.status === 'executing' || row.status === 'verifying' || row.status === 'planned') {
    return {
      step,
      status: 'verified_pending',
      result: {
        ...result,
        currentStatus: row.status,
      },
      error: 'idempotent_retry_already_in_progress',
    };
  }
  return null;
}

function parseStoredRunResult(row: ChatActionRunRow): Record<string, unknown> {
  const parsed = (() => {
    try {
      const value = row.result_json ? JSON.parse(row.result_json) : {};
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  })();
  return {
    ...parsed,
    replayed: true,
    providerObjectId: row.provider_object_id ?? parsed.providerObjectId ?? null,
    previousStatus: row.status,
  };
}

async function executeCalendarCreateStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  calendar: CalendarProviderDeps,
  persistRuns: boolean,
  confirmed: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const provider = args.provider === 'outlook_calendar' ? 'outlook' : 'google';
  if (provider === 'google' && !calendar.hasGoogle(input.userId)) {
    return { step, status: 'blocked', error: 'google_calendar_not_connected_for_write' };
  }
  if (provider === 'outlook' && !calendar.hasOutlook(input.userId)) {
    return { step, status: 'blocked', error: 'outlook_calendar_not_connected_for_write' };
  }
  if (!confirmed && Array.isArray(args.attendees) && args.attendees.length > 0) {
    return { step, status: 'needs_confirmation', error: 'attendees_require_confirmation' };
  }

  const claim = persistRuns
    ? claimChatActionRunForExecution({
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
    })
    : null;
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;

  const conflicts = await withProviderReadBackTimeout(
    calendar.getEventsForSources(args.startDateTime, args.endDateTime, input.userId, [provider as CalendarSource]),
  )
    .catch(() => [] as UnifiedCalendarEvent[]);
  if (!confirmed && conflicts.some((event) => overlaps(args.startDateTime, args.endDateTime, event.start, event.end))) {
    return { step, status: 'needs_confirmation', error: 'calendar_conflict_requires_confirmation' };
  }

  try {
    const created = await withProviderWriteTimeout((signal) => calendar.createEvent({
      title: String(args.title),
      start: String(args.startDateTime),
      end: String(args.endDateTime),
      attendees: confirmed && Array.isArray(args.attendees)
        ? args.attendees.filter((attendee: unknown): attendee is string => typeof attendee === 'string')
        : [],
      location: typeof args.location === 'string' ? args.location : undefined,
      description: typeof args.notes === 'string' ? args.notes : undefined,
      recurrence: args.recurrence ?? undefined,
    }, provider as CalendarSource, input.userId, { signal }));
    if (claim) updateChatActionRun(claim.row.id, 'verifying', { result: created, providerObjectId: created.id ?? null });
    let readBack: UnifiedCalendarEvent[];
    try {
      readBack = await withProviderReadBackTimeout(
        calendar.getEventsForSources(args.startDateTime, args.endDateTime, input.userId, [provider as CalendarSource]),
      );
    } catch (readBackErr) {
      if (claim) {
        const accepted = updateClaimedActionRun(claim, 'partial_success', {
          providerObjectId: created.id ?? null,
          verification: {
            verified: false,
            reason: readBackErr instanceof Error ? readBackErr.message : 'provider_read_back_failed',
          },
        });
        if (!accepted) return reconciliationPendingResult(step, 'partial_success');
        markPendingChatActionNeedsUserFollowup({
          userId: input.userId,
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          skill: step.skill,
          action: step.action,
          nowIso: plan.createdAt,
        });
      }
      invalidateCalendarCaches(input.userId);
      return { step, status: 'partial_success', result: { created, verified: false }, error: 'provider_read_back_failed' };
    }
    const verified = readBack.find((event) => calendarEventMatches(event, {
      title: String(args.title),
      start: String(args.startDateTime),
      end: String(args.endDateTime),
      source: provider as CalendarSource,
      id: created.id,
    }));
    if (!verified) {
      if (claim) {
        const accepted = updateClaimedActionRun(claim, 'partial_success', {
        providerObjectId: created.id ?? null,
        verification: { verified: false, reason: 'provider_read_back_mismatch' },
        });
        if (!accepted) return reconciliationPendingResult(step, 'partial_success');
        markPendingChatActionNeedsUserFollowup({
          userId: input.userId,
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          skill: step.skill,
          action: step.action,
          nowIso: plan.createdAt,
        });
      }
      return { step, status: 'partial_success', result: { created, verified: false }, error: 'provider_read_back_mismatch' };
    }
    invalidateCalendarCaches(input.userId);
    const result = { event: verified, providerObjectId: created.id, verified: true };
    if (!updateClaimedActionRun(claim, 'verified_success', {
      result,
      providerObjectId: created.id ?? verified.id ?? null,
      verification: {
        verified: true,
        expected: step.verification.expectedFields,
        actual: { title: (verified as any).title || verified.summary, start: verified.start, end: verified.end, provider: verified.source },
      },
    })) return reconciliationPendingResult(step, 'verified_success');
    return { step, status: 'verified_success', result };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'provider_create_failed' };
  }
}

async function executeCalendarUpdateStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const source = calendarSourceFromProvider(args.provider ?? step.provider);
  if (!source) return { step, status: 'blocked', error: 'calendar_provider_required' };
  if (source === 'google' && !isGoogleCalendarConfigured(input.userId)) return { step, status: 'blocked', error: 'google_calendar_not_connected_for_write' };
  if (source === 'outlook' && !isOutlookCalendarConfigured(input.userId)) return { step, status: 'blocked', error: 'outlook_calendar_not_connected_for_write' };

  const eventId = typeof args.eventId === 'string' ? args.eventId.trim() : '';
  if (!eventId) return { step, status: 'blocked', error: 'calendar_event_id_required' };
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    const updatePayload = {
      event_id: eventId,
      new_start: typeof args.startDateTime === 'string' ? args.startDateTime : typeof args.newStartDateTime === 'string' ? args.newStartDateTime : undefined,
      new_end: typeof args.endDateTime === 'string' ? args.endDateTime : typeof args.newEndDateTime === 'string' ? args.newEndDateTime : undefined,
      new_title: typeof args.title === 'string' ? args.title : typeof args.newTitle === 'string' ? args.newTitle : undefined,
      new_description: typeof args.notes === 'string' ? args.notes : typeof args.description === 'string' ? args.description : undefined,
    };
    const updated = await withProviderWriteTimeout((signal) => updateEvent(updatePayload, source, input.userId, { signal }));
    if (claim) updateChatActionRun(claim.row.id, 'verifying', { result: updated, providerObjectId: updated.id ?? eventId });
    const readStart = updatePayload.new_start || updated.start;
    const readEnd = updatePayload.new_end || updated.end;
    let readBack: UnifiedCalendarEvent[] = [];
    if (readStart && readEnd) {
      try {
        readBack = await withProviderReadBackTimeout(getEventsForSources(readStart, readEnd, input.userId, [source]));
      } catch (readBackErr) {
        if (!updateClaimedActionRun(claim, 'partial_success', {
          result: { event: updated, verified: false },
          providerObjectId: updated.id ?? eventId,
          verification: { verified: false, reason: readBackErr instanceof Error ? readBackErr.message : 'provider_read_back_failed' },
        })) return reconciliationPendingResult(step, 'partial_success');
        invalidateCalendarCaches(input.userId);
        return { step, status: 'partial_success', result: { event: updated, verified: false }, error: 'provider_read_back_failed' };
      }
    }
    const verified = readBack.some((event) => event.id === (updated.id ?? eventId));
    const result = { event: updated, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: updated.id ?? eventId,
      verification: { verified, expected: step.verification.expectedFields },
    })) return reconciliationPendingResult(step, status);
    invalidateCalendarCaches(input.userId);
    return { step, status, result, error: verified ? undefined : 'provider_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'provider_update_failed' };
  }
}

async function executeCalendarDeleteStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const source = calendarSourceFromProvider(args.provider ?? step.provider);
  if (!source) return { step, status: 'blocked', error: 'calendar_provider_required' };
  const eventId = typeof args.eventId === 'string' ? args.eventId.trim() : '';
  if (!eventId) return { step, status: 'blocked', error: 'calendar_event_id_required' };
  const readStart = typeof args.startDateTime === 'string' ? args.startDateTime : null;
  const readEnd = typeof args.endDateTime === 'string' ? args.endDateTime : null;
  if (!readStart || !readEnd) return { step, status: 'blocked', error: 'calendar_delete_requires_read_back_window' };

  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    await withProviderWriteTimeout((signal) => deleteEvent(eventId, source, input.userId, { signal }));
    if (claim) updateChatActionRun(claim.row.id, 'verifying', { providerObjectId: eventId });
    let readBack: UnifiedCalendarEvent[];
    try {
      readBack = await withProviderReadBackTimeout(getEventsForSources(readStart, readEnd, input.userId, [source]));
    } catch (readBackErr) {
      if (!updateClaimedActionRun(claim, 'partial_success', {
        result: { eventId, verified: false },
        providerObjectId: eventId,
        verification: { verified: false, reason: readBackErr instanceof Error ? readBackErr.message : 'provider_read_back_failed' },
      })) return reconciliationPendingResult(step, 'partial_success');
      invalidateCalendarCaches(input.userId);
      return { step, status: 'partial_success', result: { eventId, verified: false }, error: 'provider_read_back_failed' };
    }
    const verified = !readBack.some((event) => event.id === eventId);
    const result = { eventId, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: eventId,
      verification: { verified, expected: { eventId, absentInWindow: { start: readStart, end: readEnd } } },
    })) return reconciliationPendingResult(step, status);
    invalidateCalendarCaches(input.userId);
    return { step, status, result, error: verified ? undefined : 'provider_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'provider_delete_failed' };
  }
}

async function executeCalendarReadOnlyStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
  calendar: CalendarProviderDeps,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const source = calendarSourceFromProvider(args.provider ?? step.provider);
  const sources = source ? [source] : (['google', 'outlook'] as CalendarSource[]);
  const day = typeof args.date === 'string'
    ? DateTime.fromISO(args.date, { zone: input.timezone })
    : DateTime.fromISO(input.nowIso ?? new Date().toISOString()).setZone(input.timezone);
  const start = typeof args.startDateTime === 'string' ? args.startDateTime : day.startOf('day').toISO();
  const end = typeof args.endDateTime === 'string' ? args.endDateTime : day.endOf('day').toISO();
  if (!start || !end) return { step, status: 'blocked', error: 'calendar_window_required' };
  try {
    const events = await calendar.getEventsForSources(start, end, input.userId, sources);
    return { step, status: 'verified_success', result: { start, end, events, conflictCount: events.length } };
  } catch {
    return { step, status: 'failed', error: 'calendar_read_failed' };
  }
}

async function executeTaskCreateStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  taskProviderForUser: typeof getTaskProviderForUser,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const provider = taskProviderForUser(input.userId);
  if (typeof provider.createTask !== 'function') return { step, status: 'blocked', error: 'task_provider_not_writable' };
  const args = step.args as any;
  const claim = persistRuns
    ? claimChatActionRunForExecution({
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      normalizedActionHash: step.idempotencyKey,
      provider: 'nexus',
      actionType: step.action,
      risk: step.risk,
      request: step.args,
      nowIso: plan.createdAt,
    })
    : null;
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    const list = await resolveTaskCreationList(provider, typeof args.list === 'string' ? args.list : null);
    if (!list?.id) throw new Error('missing_task_list');
    const created = await withProviderWriteTimeout(() => provider.createTask(String(list.id), list.displayName || list.name || 'Tasks', {
      title: String(args.title),
      body: typeof args.notes === 'string' ? args.notes : undefined,
      dueDateTime: typeof args.dueDateTime === 'string' ? args.dueDateTime : undefined,
    }));
    if (!created?.success || !created.data?.id) throw new Error('task_create_failed');
    const readBack = typeof provider.getTask === 'function'
      ? await provider.getTask(String(list.id), String(created.data.id), list.displayName || list.name || 'Tasks')
      : null;
    const verified = !readBack || (readBack.success !== false && String(readBack.data?.title || readBack.data?.subject || created.data.title || '').trim() === String(args.title).trim());
    const result = { task: created.data, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: String(created.data.id),
      verification: { verified, expected: step.verification.expectedFields },
    })) return reconciliationPendingResult(step, status);
    if (verified) {
      const now = new Date().toISOString();
      rememberRecentChatEntity({
        userId: input.userId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        node: {
          entityId: String(created.data.id),
          entityType: 'task',
          provider: 'nexus',
          surface: 'chat',
          userVisibleLabel: String(args.title),
          createdOrViewedAt: now,
          lastVerifiedAt: now,
          allowedFollowupActions: ['complete_task', 'update_task', 'delete_task'],
          confidence: 0.96,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          sourceTurnId: input.messageId,
          metadata: {
            listId: String(list.id),
            listName: list.displayName || list.name || 'Tasks',
          },
        },
      });
    }
    return { step, status, result };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'task_create_failed' };
  }
}

async function executeTaskMutationStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  taskProviderForUser: typeof getTaskProviderForUser,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const provider = taskProviderForUser(input.userId);
  const args = step.args as any;
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    if (step.action === 'create_checklist') {
      if (typeof provider.createTask !== 'function') throw new Error('task_provider_not_writable');
      const list = await resolveTaskCreationList(provider, typeof args.list === 'string' ? args.list : null);
      if (!list?.id) throw new Error('missing_task_list');
      const created = await withProviderWriteTimeout(() => provider.createTask(String(list.id), list.displayName || list.name || 'Tasks', {
        title: String(args.title),
        body: typeof args.notes === 'string' ? args.notes : undefined,
      }));
      if (!created?.success || !created.data?.id) throw new Error('task_create_failed');
      const items = Array.isArray(args.items) ? args.items.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0) : [];
      const added: unknown[] = [];
      for (const item of items) {
        if (typeof provider.addChecklistItem !== 'function') break;
        const addedItem = await withProviderWriteTimeout(() => provider.addChecklistItem(String(list.id), String(created.data.id), item));
        added.push(addedItem?.data ?? addedItem);
      }
      const verified = items.length === 0 || added.length === items.length;
      const result = { task: created.data, checklistItems: added, verified };
      const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
      if (!updateClaimedActionRun(claim, status, { result, providerObjectId: String(created.data.id), verification: { verified } })) {
        return reconciliationPendingResult(step, status);
      }
      return { step, status, result, error: verified ? undefined : 'checklist_provider_partial' };
    }

    const target = await resolveTaskMutationTarget(provider, args);
    if (!target) return { step, status: 'blocked', error: 'task_target_not_found_or_ambiguous' };
    if (step.action === 'complete_task') {
      if (typeof provider.completeTask !== 'function') throw new Error('task_provider_cannot_complete');
      await withProviderWriteTimeout(() => provider.completeTask(target.listId, target.taskId));
    } else if (step.action === 'delete_task') {
      if (typeof provider.deleteTask !== 'function') throw new Error('task_provider_cannot_delete');
      await withProviderWriteTimeout(() => provider.deleteTask(target.listId, target.taskId));
    } else {
      if (typeof provider.updateTask !== 'function') throw new Error('task_provider_cannot_update');
      const changed = typeof args.changedFields === 'object' && args.changedFields ? args.changedFields as Record<string, unknown> : {};
      const updates = {
        ...changed,
        title: typeof args.title === 'string' ? args.title : changed.title,
        body: typeof args.notes === 'string' ? args.notes : changed.body,
        dueDateTime: typeof args.reminderAt === 'string'
          ? args.reminderAt
          : typeof args.dueDateTime === 'string'
            ? args.dueDateTime
            : changed.dueDateTime,
      };
      await withProviderWriteTimeout(() => provider.updateTask(target.listId, target.taskId, updates, target.listName));
    }

    const readBack = typeof provider.getTask === 'function'
      ? await provider.getTask(target.listId, target.taskId, target.listName)
      : null;
    const verified = step.action === 'delete_task'
      ? !readBack || readBack.success === false || !readBack.data
      : !readBack || readBack.success !== false;
    const result = { taskId: target.taskId, listId: target.listId, verified, task: readBack?.data ?? null };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: target.taskId,
      verification: { verified, expected: step.verification.expectedFields },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'task_mutation_failed' };
  }
}

function executeContentAgencyStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const claim = persistRuns ? claimChatActionRunForExecution({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    normalizedActionHash: step.idempotencyKey,
    provider: 'nexus',
    actionType: step.action,
    risk: step.risk,
    request: step.args,
    nowIso: plan.createdAt,
  }) : null;
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    const pkg = buildContentAgencyPackage({
      userId: input.userId,
      tenantId: input.tenantId,
      brief: {
        userId: input.userId,
        tenantId: input.tenantId,
        goal: String(args.goal || args.objective || args.topic || 'Create content from chat request'),
        objective: String(args.objective || args.topic || input.text),
        audience: typeof args.audience === 'string' ? args.audience : null,
        platform: typeof args.platform === 'string' ? args.platform : 'generic',
        format: typeof args.format === 'string' ? args.format : null,
        notes: input.text,
      },
    });
    persistContentAgencyArtifact('package', pkg);
    const readBack = getContentAgencyProject({ userId: input.userId, tenantId: input.tenantId, id: pkg.id });
    const verified = readBack?.kind === 'package' && readBack.artifact?.id === pkg.id;
    const result = {
      packageId: pkg.id,
      brief: pkg.brief,
      firstScript: pkg.scriptVariants[0] ?? null,
      quality: pkg.quality,
      verified,
    };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: pkg.id,
      verification: { verified, expected: { packageId: pkg.id } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'content_agency_package_failed' };
  }
}

function executeContentScheduleWorkStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : null;
  const dateTime = typeof args.dateTime === 'string' && args.dateTime.trim() ? DateTime.fromISO(args.dateTime, { zone: input.timezone }) : null;
  if (!title || !dateTime?.isValid) return { step, status: 'blocked', error: 'content_schedule_requires_title_and_datetime' };
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    const topic = addTopic(input.userId, title, {
      notes: typeof args.notes === 'string' ? args.notes : 'Created from Chat action.',
      scheduledDate: dateTime.toISODate(),
      scheduledAt: dateTime.toISO(),
      status: 'planned',
    });
    const readBack = getTopicById(input.userId, topic.id);
    const verified = Boolean(readBack && readBack.title === title && readBack.scheduled_date === dateTime.toISODate());
    const result = { topic: readBack ?? topic, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: String(topic.id),
      verification: { verified, expected: { title, date: dateTime.toISODate() } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'content_schedule_failed' };
  }
}

function executeContentPipelineHandoffStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const packageId = typeof (step.args as any).packageId === 'string' ? String((step.args as any).packageId).trim() : '';
  if (!packageId) return { step, status: 'blocked', error: 'content_pipeline_package_id_required' };
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    const handoff = handoffContentAgencyPackageToPipeline({
      userId: input.userId,
      tenantId: input.tenantId,
      packageId,
    });
    const verified = handoff.status === 'created' || handoff.status === 'already_exists';
    const status: ChatActionRunStatus = verified ? 'verified_success' : handoff.status === 'blocked' ? 'blocked' : 'failed';
    if (!updateClaimedActionRun(claim, status, {
      result: handoff,
      providerObjectId: handoff.pipelineId != null ? String(handoff.pipelineId) : packageId,
      verification: { verified, expected: { packageId }, actual: { status: handoff.status, pipelineId: handoff.pipelineId } },
      error: verified ? undefined : { reason: handoff.blockers[0] ?? handoff.status },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result: handoff, error: verified ? undefined : handoff.blockers[0] ?? 'content_pipeline_handoff_failed' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'content_pipeline_handoff_failed' };
  }
}

function executeCookingGroceryListStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const weekStart = String(args.weekStart || '');
  const claim = persistRuns ? claimChatActionRunForExecution({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    normalizedActionHash: step.idempotencyKey,
    provider: 'nexus',
    actionType: step.action,
    risk: step.risk,
    request: step.args,
    nowIso: plan.createdAt,
  }) : null;
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    const list = generateShoppingList(input.userId, weekStart, input.tenantId);
    const readBack = getShoppingList(input.userId, weekStart, input.tenantId);
    const verified = readBack?.week_start === list.week_start;
    const result = { weekStart, itemCount: list.items.length, items: list.items.slice(0, 12), verified: Boolean(verified) };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: `shopping-list:${weekStart}`,
      verification: { verified, expected: { weekStart } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'cooking_grocery_list_failed' };
  }
}

function executeCookingMealPlanStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const date = typeof args.date === 'string' ? args.date.trim() : '';
  const mealType = typeof args.mealType === 'string' ? args.mealType.trim().toLowerCase() : '';
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !mealType || !title) {
    return { step, status: 'blocked', error: 'cooking_meal_plan_requires_date_meal_type_and_title' };
  }
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    const meal = setMealPlan(input.userId, date, mealType, title, {
      notes: typeof args.notes === 'string' ? args.notes : 'Created from Chat action.',
      tenantId: input.tenantId,
    });
    const readBack = getMealPlan(input.userId, date, date, input.tenantId)
      .find((candidate) => candidate.id === meal.id || (candidate.meal_type === mealType && candidate.title === title));
    const verified = Boolean(readBack && readBack.title === title && readBack.meal_type === mealType);
    const result = { meal: readBack ?? meal, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: String(meal.id),
      verification: { verified, expected: { date, mealType, title } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'cooking_meal_plan_failed' };
  }
}

function executeCookingSupportStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const now = DateTime.fromISO(input.nowIso ?? new Date().toISOString()).setZone(input.timezone);
  const start = now.startOf('week').toISODate() || now.toISODate();
  const end = now.endOf('week').toISODate() || now.toISODate();
  if (!start || !end) return { step, status: 'blocked', error: 'cooking_date_range_required' };
  try {
    const meals = getMealPlan(input.userId, start, end, input.tenantId);
    const shopping = getShoppingList(input.userId, start, input.tenantId);
    return {
      step,
      status: 'verified_success',
      result: {
        dateRange: { start, end },
        plannedMeals: meals.length,
        shoppingItemCount: shopping?.items.length ?? 0,
        guidance: step.action === 'cooking_fueling_support'
          ? 'Use planned meals and shopping coverage to protect pre/post-training fueling.'
          : 'Use current meal-plan and shopping-list truth before changing meals.',
      },
    };
  } catch {
    return { step, status: 'failed', error: 'cooking_support_failed' };
  }
}

function executeFinanceSummaryStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const month = String((step.args as any).month || DateTime.now().setZone(input.timezone).toFormat('yyyy-MM'));
  try {
    const summary = getMonthlySummary(input.userId, month, { tenantId: input.tenantId });
    const currency = getPreferredCurrencyForUser(input.userId);
    return { step, status: 'verified_success', result: { month, summary, currency } };
  } catch {
    return { step, status: 'failed', error: 'finance_summary_failed' };
  }
}

async function executeFinanceReminderStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  taskProviderForUser: typeof getTaskProviderForUser,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  if (typeof args.dueDate !== 'string' || !args.dueDate.trim()) {
    return { step, status: 'blocked', error: 'finance_reminder_due_date_required' };
  }
  const reminderStep: ChatPlanStep = {
    ...step,
    skill: 'tasks',
    action: 'create_task',
    type: 'create_task',
    risk: 'safe_write',
    args: {
      title: String(args.title || 'Finance reminder'),
      list: null,
      dueDateTime: args.dueDate,
      notes: 'Created from Finance chat action.',
    },
    verification: { required: true, method: 'local_read_back', expectedFields: { title: String(args.title || 'Finance reminder') } },
  };
  return executeTaskCreateStep(reminderStep, plan, input, taskProviderForUser, persistRuns);
}

function executeFinanceCategorizeReceiptStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const transactionId = Number(args.transactionId ?? args.receiptId);
  const category = typeof args.category === 'string' ? args.category.trim() : '';
  if (!Number.isInteger(transactionId) || transactionId <= 0 || !category) {
    return { step, status: 'blocked', error: 'finance_categorization_requires_transaction_and_category' };
  }
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    const updated = updateTransactionCategory(input.userId, transactionId, category, {
      subcategory: typeof args.subcategory === 'string' ? args.subcategory : null,
      tenantId: input.tenantId,
    });
    if (!updated) {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', { error: { reason: 'finance_transaction_not_found_or_unauthorized' } });
      return { step, status: 'blocked', error: 'finance_transaction_not_found_or_unauthorized' };
    }
    const verified = updated.category === category;
    const result = { transactionId, category: updated.category, subcategory: updated.subcategory, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: String(transactionId),
      verification: { verified, expected: { transactionId, category } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'finance_categorization_failed' };
  }
}

function executeFinancePaymentActionStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
  const month = typeof args.month === 'string' ? args.month.trim() : '';
  if (!['mark_tax_paid', 'mark_paid'].includes(action)) {
    return { step, status: 'blocked', error: 'external_financial_payment_not_enabled_for_chat' };
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return { step, status: 'blocked', error: 'finance_payment_month_required' };
  }
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    const ok = markTaxPaid(input.userId, month, { tenantId: input.tenantId });
    if (!ok) {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', { error: { reason: 'finance_tax_event_not_found_or_unauthorized' } });
      return { step, status: 'blocked', error: 'finance_tax_event_not_found_or_unauthorized' };
    }
    const year = Number(month.slice(0, 4));
    const readBack = getTaxEvents(input.userId, { year, limit: 24, tenantId: input.tenantId }).find((event) => event.month === month);
    const verified = readBack?.status === 'paid';
    const result = { month, status: readBack?.status ?? null, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: `finance_tax_event:${month}`,
      verification: { verified, expected: { month, status: 'paid' } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'finance_payment_action_failed' };
  }
}

function executeConnectionsStatusStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  try {
    const summary = getIntegrationSummary(input.userId);
    const requestedProvider = typeof (step.args as any).provider === 'string' ? (step.args as any).provider : null;
    const providers = requestedProvider
      ? summary.providers.filter((provider) => provider.provider === requestedProvider)
      : summary.providers;
    return { step, status: 'verified_success', result: { providers, counts: summary.counts, capabilities: summary.capabilities } };
  } catch {
    return { step, status: 'failed', error: 'connections_status_failed' };
  }
}

function executeConnectionsReconnectGuidanceStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const status = executeConnectionsStatusStep(step, input);
  if (status.status !== 'verified_success') return status;
  const provider = typeof (step.args as any).provider === 'string' ? (step.args as any).provider : null;
  return {
    step,
    status: 'verified_success',
    result: {
      ...(status.result as Record<string, unknown>),
      guidance: provider
        ? `Open Connections and reconnect ${provider} with the required scopes.`
        : 'Open Connections and reconnect the provider that is expired or missing required scopes.',
    },
  };
}

function executeTrainingCoachReportStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  try {
    const summary = getActivePlanSummary(input.userId);
    return { step, status: 'verified_success', result: { summary: summary || 'No active training plan found.' } };
  } catch {
    return { step, status: 'failed', error: 'training_summary_failed' };
  }
}

function executeTrainingExplainSessionStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const sessionId = Number((step.args as any).sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return { step, status: 'blocked', error: 'training_session_id_required' };
  try {
    const session = getSessionById(sessionId);
    if (!session) return { step, status: 'blocked', error: 'training_session_not_found' };
    const plan = getPlanById(session.plan_id);
    if (!plan || plan.user_id !== input.userId) return { step, status: 'blocked', error: 'training_session_not_found_or_unauthorized' };
    return {
      step,
      status: 'verified_success',
      result: {
        sessionId,
        title: session.title,
        sessionType: session.session_type,
        durationMinutes: session.duration_minutes,
        intensity: session.intensity_text,
        status: session.status,
      },
    };
  } catch {
    return { step, status: 'failed', error: 'training_session_read_failed' };
  }
}

function executeTrainingPlanCreateStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as Record<string, unknown>;
  const missing = missingTrainingPlanSlots(args);
  const pending = upsertPendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'training',
    action: 'training_plan_create',
    collectedSlots: args,
    missingSlots: missing,
    riskClass: 'R1',
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    originatingSurface: input.channel,
    nowIso: plan.createdAt,
  });
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (!updateClaimedActionRun(claim, 'verified_pending', {
    result: {
      pendingActionId: pending.id,
      missingSlots: missing,
      collectedSlots: args,
      openSurface: 'training_plan_builder',
    },
    providerObjectId: pending.id,
    verification: { verified: false, reason: 'ui_handoff_required', pendingActionId: pending.id },
  })) return reconciliationPendingResult(step, 'verified_pending');
  return {
    step,
    status: 'verified_pending',
    result: {
      pendingActionId: pending.id,
      missingSlots: missing,
      collectedSlots: args,
      openSurface: 'training_plan_builder',
      verified: false,
    },
  };
}

async function executeTrainingReflowStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
  confirmed: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const sessionId = Number(args.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return { step, status: 'blocked', error: 'training_session_id_required' };
  const source = calendarSourceFromProvider(args.provider ?? step.provider);
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    if (step.action === 'training_reflow_preview') {
      const preview = await withProviderWriteTimeout(() => previewTrainingSessionReflow(input.userId, sessionId, source, input.tenantId));
      const verified = preview.status === 'preview';
      const status: ChatActionRunStatus = verified ? 'verified_success' : preview.status === 'blocked' || preview.status === 'forbidden' || preview.status === 'no_calendar' ? 'blocked' : 'failed';
      if (!updateClaimedActionRun(claim, status, {
        result: preview,
        providerObjectId: String(sessionId),
        verification: { verified, expected: { sessionId } },
      })) return reconciliationPendingResult(step, status);
      return { step, status, result: preview, error: verified ? undefined : preview.data.reason ?? preview.status };
    }
    if (!confirmed) {
      return { step, status: 'needs_confirmation', error: 'confirmation_required' };
    }
    const confirmedReflow = await withProviderWriteTimeout((signal) => confirmTrainingSessionReflow({
      userId: input.userId,
      tenantId: input.tenantId,
      sessionId,
      proposedStartAt: typeof args.proposedStartAt === 'string' ? args.proposedStartAt : typeof args.startDateTime === 'string' ? args.startDateTime : null,
      proposedEndAt: typeof args.proposedEndAt === 'string' ? args.proposedEndAt : typeof args.endDateTime === 'string' ? args.endDateTime : null,
      requestedCalendarSource: source,
      signal,
    }));
    const verified = confirmedReflow.status === 'confirmed' && confirmedReflow.data.verified === true;
    const status: ChatActionRunStatus = verified ? 'verified_success' : confirmedReflow.status === 'partial_failure' ? 'partial_success' : 'blocked';
    if (!updateClaimedActionRun(claim, status, {
      result: confirmedReflow,
      providerObjectId: 'data' in confirmedReflow && 'eventId' in confirmedReflow.data ? confirmedReflow.data.eventId ?? String(sessionId) : String(sessionId),
      verification: { verified, expected: { sessionId } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result: confirmedReflow, error: verified ? undefined : (confirmedReflow.data as any).reason ?? confirmedReflow.status };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'training_reflow_failed' };
  }
}

async function executeMailUnreadCountStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  try {
    const summary = await getUnreadMailSummaryForUser(input.userId);
    return { step, status: 'verified_success', result: summary };
  } catch {
    return { step, status: 'failed', error: 'mail_unread_failed' };
  }
}

async function executeMailInboxSummaryStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const provider = String(args.provider || step.provider || '').toLowerCase();
  const limit = Math.max(1, Math.min(10, Number(args.limit) || 5));
  const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : 'in:inbox newer_than:14d';
  try {
    if (provider === 'gmail') {
      const messages = await searchGmailEmailsForUser(input.userId, query, limit);
      return { step, status: 'verified_success', result: { provider: 'gmail', messages: messages.map(mailMessageSummary) } };
    }
    if (provider === 'outlook_mail') {
      const messages = await searchOutlookEmailsForUser(input.userId, query, limit);
      return { step, status: 'verified_success', result: { provider: 'outlook_mail', messages: messages.map(mailMessageSummary) } };
    }
    const summary = await getUnreadMailSummaryForUser(input.userId);
    return { step, status: 'verified_success', result: { provider: 'unified', unread: summary } };
  } catch {
    return { step, status: 'failed', error: 'mail_summary_failed' };
  }
}

function executeNotificationExplainStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  try {
    const profile = getOrCreateNotificationProfile(input.userId, input.tenantId);
    return { step, status: 'verified_success', result: { profile, topic: (step.args as any).topic ?? null } };
  } catch {
    return { step, status: 'failed', error: 'notification_profile_failed' };
  }
}

async function executeNotificationMutationStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    if (step.action === 'notification_update_preference') {
      const patch = typeof args.preference === 'object' && args.preference ? args.preference as Record<string, unknown> : {};
      if (Object.keys(patch).length === 0) return { step, status: 'blocked', error: 'notification_preference_patch_required' };
      const profile = updateNotificationProfile(input.userId, input.tenantId, patch as any);
      const readBack = getOrCreateNotificationProfile(input.userId, input.tenantId);
      const verified = JSON.stringify(profile) === JSON.stringify(readBack);
      const result = { profile: readBack, verified };
      const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
      if (!updateClaimedActionRun(claim, status, { result, verification: { verified } })) return reconciliationPendingResult(step, status);
      return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
    }
    const created = await withProviderWriteTimeout(() => createNotificationIntent({
      userId: input.userId,
      tenantId: input.tenantId,
      sourceSkill: 'chat',
      type: 'reminder',
      priority: 'active',
      title: String(args.title || 'Nexus reminder'),
      body: String(args.body || args.title || 'Nexus reminder'),
      deeplink: null,
      dedupeKey: step.idempotencyKey,
      deliveryPolicy: 'in_app_only',
      privacyPolicy: 'standard',
      requiresUserAction: false,
    }));
    const verified = created.intent?.intentId != null;
    const result = { intentId: created.intent.intentId, notificationId: created.item?.itemId ?? null, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, { result, providerObjectId: created.intent.intentId, verification: { verified } })) {
      return reconciliationPendingResult(step, status);
    }
    return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'notification_action_failed' };
  }
}

async function executeDecisionCenterStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const decisionId = typeof args.decisionId === 'string' ? args.decisionId.trim() : '';
  if (!decisionId) return { step, status: 'blocked', error: 'decision_id_required' };
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    let result: unknown;
    if (step.action === 'decision_dismiss') {
      result = dismissDecision(decisionId, input.userId, input.tenantId);
    } else if (step.action === 'decision_snooze') {
      const minutes = typeof args.minutes === 'number' ? args.minutes : 60;
      result = snoozeDecision(decisionId, input.userId, input.tenantId, minutes);
    } else if (step.action === 'decision_choose') {
      const choice = typeof args.choice === 'string' ? args.choice : typeof args.actionId === 'string' ? args.actionId : '';
      if (!choice) return { step, status: 'blocked', error: 'decision_choice_required' };
      result = await withProviderWriteTimeout(() => performDecisionAction(decisionId, choice, input.userId, input.tenantId, {
        idempotencyKey: step.idempotencyKey,
        payload: typeof args.payload === 'object' && args.payload ? args.payload as Record<string, unknown> : {},
      }));
    } else {
      result = getDecisionItem(decisionId, input.userId, input.tenantId);
    }
    const readBack = getDecisionItem(decisionId, input.userId, input.tenantId);
    const verified = Boolean(readBack);
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    const payload = { result, item: readBack, verified };
    if (!updateClaimedActionRun(claim, status, { result: payload, providerObjectId: decisionId, verification: { verified } })) {
      return reconciliationPendingResult(step, status);
    }
    return { step, status, result: payload, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'decision_action_failed' };
  }
}

function overlaps(startA: string, endA: string, startB: string, endB: string): boolean {
  const a1 = DateTime.fromISO(startA).toMillis();
  const a2 = DateTime.fromISO(endA).toMillis();
  const b1 = DateTime.fromISO(startB).toMillis();
  const b2 = DateTime.fromISO(endB).toMillis();
  return Number.isFinite(a1) && Number.isFinite(a2) && Number.isFinite(b1) && Number.isFinite(b2) && a1 < b2 && b1 < a2;
}

function calendarEventMatches(event: UnifiedCalendarEvent, expected: { title: string; start: string; end: string; source: CalendarSource; id?: string }): boolean {
  const title = String((event as any).title || event.summary || '').trim().toLowerCase();
  const expectedTitle = expected.title.trim().toLowerCase();
  if (event.source !== expected.source) return false;
  if (expected.id && event.id === expected.id) return true;
  return title === expectedTitle
    && Math.abs(DateTime.fromISO(event.start).toMillis() - DateTime.fromISO(expected.start).toMillis()) < 60_000
    && Math.abs(DateTime.fromISO(event.end).toMillis() - DateTime.fromISO(expected.end).toMillis()) < 60_000;
}

function getProviderReadBackTimeoutMs(): number {
  const raw = process.env.CHAT_PROVIDER_READ_BACK_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROVIDER_READ_BACK_TIMEOUT_MS;
}

function getProviderWriteTimeoutMs(): number {
  const raw = process.env.CHAT_PROVIDER_WRITE_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROVIDER_WRITE_TIMEOUT_MS;
}

async function withProviderWriteTimeout<T>(
  operation: ((signal: AbortSignal) => Promise<T> | T) | Promise<T> | T,
  timeoutMs = getProviderWriteTimeoutMs(),
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  try {
    const promise = typeof operation === 'function'
      ? Promise.resolve((operation as (signal: AbortSignal) => Promise<T> | T)(controller.signal))
      : Promise.resolve(operation);
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('provider_write_timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withProviderReadBackTimeout<T>(operation: Promise<T>, timeoutMs = getProviderReadBackTimeoutMs()): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('provider_read_back_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function calendarSourceFromProvider(provider: unknown): CalendarSource | null {
  if (provider === 'google' || provider === 'google_calendar') return 'google';
  if (provider === 'outlook' || provider === 'outlook_calendar') return 'outlook';
  return null;
}

function claimActionRunForStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): ReturnType<typeof claimChatActionRun> | null {
  if (!persistRuns) return null;
  return claimChatActionRun({
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
}

function claimActionRunForStepExecution(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): ReturnType<typeof claimChatActionRun> | null {
  if (!persistRuns) return null;
  return claimChatActionRunForExecution({
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
}

async function resolveTaskMutationTarget(
  provider: any,
  args: Record<string, unknown>,
): Promise<{ taskId: string; listId: string; listName?: string } | null> {
  const explicitTaskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
  const explicitListId = typeof args.listId === 'string' ? args.listId.trim() : typeof args.list === 'string' ? args.list.trim() : '';
  if (explicitTaskId && explicitListId) {
    return { taskId: explicitTaskId, listId: explicitListId, listName: typeof args.listName === 'string' ? args.listName : undefined };
  }
  const title = typeof args.title === 'string' ? args.title.trim().toLowerCase() : '';
  const searchQuery = title || explicitTaskId;
  const candidates = typeof provider.searchTasks === 'function'
    ? await provider.searchTasks(searchQuery)
    : typeof provider.getAllPendingTasks === 'function'
      ? await provider.getAllPendingTasks()
      : null;
  const data = Array.isArray(candidates?.data) ? candidates.data : [];
  const matches = data.filter((candidate: any) => {
    const id = String(candidate.id || candidate.taskId || '').trim();
    const candidateTitle = String(candidate.title || candidate.subject || '').trim().toLowerCase();
    if (explicitTaskId && id === explicitTaskId) return true;
    if (title && candidateTitle === title) return true;
    return false;
  });
  if (matches.length !== 1) return null;
  const match = matches[0] as any;
  const taskId = String(match.id || match.taskId || '');
  const listId = String(match.listId || match.projectId || explicitListId || '');
  if (!taskId || !listId) return null;
  return { taskId, listId, listName: typeof match.listName === 'string' ? match.listName : typeof match.projectName === 'string' ? match.projectName : undefined };
}

function mailMessageSummary(message: any): Record<string, unknown> {
  return {
    id: message.id,
    from: message.from,
    subject: message.subject,
    date: message.date,
    snippet: message.snippet ? String(message.snippet).slice(0, 180) : undefined,
  };
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

function recordShadowTelemetry(plan: ChatActionPlan, input: ChatPlannerInput, routeStartedAtMs: number): void {
  if (input.persistRuns === false) return;
  const firstStep = plan.steps[0];
  try {
    recordChatActionTelemetry({
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      planner: plan.planner,
      status: 'shadow_only',
      skill: firstStep?.skill ?? null,
      action: firstStep?.action ?? null,
      telemetry: {
        ...(plan.telemetry ?? {
          routeTier: 'tier0_deterministic',
          candidates: firstStep ? [{ skill: firstStep.skill, action: firstStep.action, score: plan.effectiveConfidence ?? plan.confidence }] : [],
          calibratedScore: plan.effectiveConfidence ?? plan.confidence,
          threshold: thresholdForSteps(plan.steps),
        }),
        latencyMs: Date.now() - routeStartedAtMs,
        outcome: 'shadow_only',
        predictedActionHash: firstStep?.idempotencyKey,
        slotProvenanceSummary: summarizeSlotProvenance(plan),
      },
      nowIso: input.nowIso,
    });
  } catch (err) {
    logger.debug({ err, userId: input.userId, tenantId: input.tenantId }, 'chat action shadow telemetry skipped');
  }
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

function successCopy(input: ChatPlannerInput, results: Array<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown }>): string {
  const first = results[0];
  if (first?.step.type === 'answer') {
    return String((first.result as any)?.text || (first.step.args as any).text || '');
  }
  if ((first?.result as any)?.replayed === true) {
    return input.locale?.startsWith('pt')
      ? 'Esse pedido já foi tratado, por isso não criei uma duplicação.'
      : 'I already handled that request, so I did not create a duplicate.';
  }
  if (first?.step.action === 'schedule_event') {
    const args = first.step.args as any;
    const provider = args.provider === 'outlook_calendar' ? 'Outlook Calendar' : 'Google Calendar';
    const start = DateTime.fromISO(String(args.startDateTime)).setZone(input.timezone);
    const end = DateTime.fromISO(String(args.endDateTime)).setZone(input.timezone);
    if (input.locale?.startsWith('pt')) {
      return `Feito — criei “${args.title}” no ${provider} para ${start.setLocale('pt').toFormat("cccc, d 'de' LLLL")}, das ${start.toFormat('HH:mm')} às ${end.toFormat('HH:mm')}.`;
    }
    return `Done — I created “${args.title}” in ${provider} for ${start.toFormat('cccc, LLL d')}, ${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}.`;
  }
  if (first?.step.action === 'check_calendar_conflicts') {
    const count = Number((first.result as any)?.conflictCount ?? 0);
    return input.locale?.startsWith('pt')
      ? count > 0 ? `Encontrei ${count} evento(s) nesse horário.` : 'Não encontrei conflitos nesse horário.'
      : count > 0 ? `I found ${count} event(s) in that window.` : 'I did not find conflicts in that window.';
  }
  if (first?.step.action === 'summarize_agenda') {
    const count = Array.isArray((first.result as any)?.events) ? (first.result as any).events.length : 0;
    return input.locale?.startsWith('pt')
      ? `A tua agenda tem ${count} evento(s) nesse período.`
      : `Your agenda has ${count} event(s) in that window.`;
  }
  if (first?.step.action === 'update_event' || first?.step.action === 'move_event') {
    return input.locale?.startsWith('pt') ? 'Feito — atualizei o evento e verifiquei no calendário.' : 'Done — I updated the event and verified it in the calendar.';
  }
  if (first?.step.action === 'delete_event') {
    return input.locale?.startsWith('pt') ? 'Feito — apaguei o evento e confirmei que já não aparece nesse período.' : 'Done — I deleted the event and confirmed it no longer appears in that window.';
  }
  if (first?.step.action === 'mail_unread_count') {
    const total = Number((first.result as any)?.totalUnread ?? 0);
    return input.locale?.startsWith('pt') ? `Tens ${total} e-mail(s) não lidos.` : `You have ${total} unread email(s).`;
  }
  if (first?.step.action === 'mail_inbox_summary') {
    const messages = Array.isArray((first.result as any)?.messages) ? (first.result as any).messages : [];
    return input.locale?.startsWith('pt')
      ? `Encontrei ${messages.length} mensagem(ns) relevantes na caixa de entrada.`
      : `I found ${messages.length} relevant inbox message(s).`;
  }
  if (first?.step.action === 'create_task') {
    const title = String((first.step.args as any).title);
    return input.locale?.startsWith('pt') ? `Feito — criei a tarefa “${title}”.` : `Done — I created the task “${title}”.`;
  }
  if (first?.step.action === 'update_task' || first?.step.action === 'complete_task' || first?.step.action === 'delete_task' || first?.step.action === 'create_checklist' || first?.step.action === 'set_task_reminder') {
    return input.locale?.startsWith('pt') ? 'Feito — atualizei a tarefa e verifiquei a alteração.' : 'Done — I updated the task and verified the change.';
  }
  if (first?.step.action === 'content_script_create' || first?.step.action === 'content_brief_create') {
    const result = first.result as any;
    const script = result?.firstScript;
    const label = first.step.action === 'content_script_create'
      ? (input.locale?.startsWith('pt') ? 'roteiro' : 'script')
      : (input.locale?.startsWith('pt') ? 'brief de conteúdo' : 'content brief');
    if (input.locale?.startsWith('pt')) {
      return script?.coldOpen
        ? `Feito — criei um ${label} e guardei o pacote no Content. Primeiro hook: “${script.coldOpen}”`
        : `Feito — criei um ${label} e guardei o pacote no Content.`;
    }
    return script?.coldOpen
      ? `Done — I created a ${label} and saved the package in Content. First hook: “${script.coldOpen}”`
      : `Done — I created a ${label} and saved the package in Content.`;
  }
  if (first?.step.action === 'content_schedule_work') {
    const title = String((first.step.args as any).title || 'content work');
    return input.locale?.startsWith('pt') ? `Feito — agendei “${title}” no Content e verifiquei a gravação.` : `Done — I scheduled “${title}” in Content and verified it was saved.`;
  }
  if (first?.step.action === 'content_pipeline_handoff') {
    return input.locale?.startsWith('pt') ? 'Feito — movi o pacote para o pipeline de Content e verifiquei o read-back.' : 'Done — I moved the package into the Content pipeline and verified the read-back.';
  }
  if (first?.step.action === 'cooking_grocery_list') {
    const itemCount = Number((first.result as any)?.itemCount ?? 0);
    return input.locale?.startsWith('pt')
      ? `Feito — gerei a lista de compras desta semana com ${itemCount} item(ns) e verifiquei a gravação.`
      : `Done — I generated this week's grocery list with ${itemCount} item(s) and verified it was saved.`;
  }
  if (first?.step.action === 'cooking_meal_plan') {
    const args = first.step.args as any;
    return input.locale?.startsWith('pt')
      ? `Feito — guardei “${args.title}” para ${args.mealType} em ${args.date} e verifiquei o plano.`
      : `Done — I saved “${args.title}” for ${args.mealType} on ${args.date} and verified the plan.`;
  }
  if (first?.step.action === 'cooking_meal_support' || first?.step.action === 'cooking_fueling_support') {
    const result = first.result as any;
    return input.locale?.startsWith('pt')
      ? `Cozinha: há ${result?.plannedMeals ?? 0} refeição(ões) planeadas e ${result?.shoppingItemCount ?? 0} item(ns) na lista de compras desta semana.`
      : `Cooking: there are ${result?.plannedMeals ?? 0} planned meal(s) and ${result?.shoppingItemCount ?? 0} shopping item(s) this week.`;
  }
  if (first?.step.action === 'finance_summary') {
    const result = first.result as any;
    const summary = result?.summary;
    if (summary && input.locale?.startsWith('pt')) {
      return `Resumo financeiro de ${result.month}: receitas ${formatCurrencyAmount(result.currency, summary.totalIncome)}, despesas ${formatCurrencyAmount(result.currency, summary.totalExpenses)}.`;
    }
    if (summary) {
      return `Finance summary for ${result.month}: income ${formatCurrencyAmount(result.currency, summary.totalIncome)}, expenses ${formatCurrencyAmount(result.currency, summary.totalExpenses)}.`;
    }
  }
  if (first?.step.action === 'finance_categorize_receipt') {
    const result = first.result as any;
    return input.locale?.startsWith('pt')
      ? `Feito — categorizei o recibo/transação como ${result?.category ?? 'categoria indicada'} e verifiquei a alteração.`
      : `Done — I categorized the receipt/transaction as ${result?.category ?? 'the requested category'} and verified the change.`;
  }
  if (first?.step.action === 'finance_payment_action') {
    const result = first.result as any;
    return input.locale?.startsWith('pt')
      ? `Feito — marquei o evento financeiro de ${result?.month ?? 'esse mês'} como pago e verifiquei o estado.`
      : `Done — I marked the finance event for ${result?.month ?? 'that month'} as paid and verified the status.`;
  }
  if (first?.step.action === 'connections_status') {
    const count = Array.isArray((first.result as any)?.providers) ? (first.result as any).providers.length : 0;
    return input.locale?.startsWith('pt')
      ? `Verifiquei as conexões: encontrei ${count} provedor(es) no estado atual.`
      : `I checked connections: ${count} provider(s) are in the current status view.`;
  }
  if (first?.step.action === 'connections_reconnect_guidance') {
    return input.locale?.startsWith('pt')
      ? 'Verifiquei o estado da conexão e preparei a orientação de reconexão.'
      : 'I checked the connection state and prepared reconnect guidance.';
  }
  if (first?.step.action === 'training_coach_report') {
    const summary = String((first.result as any)?.summary || '');
    return input.locale?.startsWith('pt')
      ? `Resumo de treino: ${summary.slice(0, 220)}`
      : `Training summary: ${summary.slice(0, 220)}`;
  }
  if (first?.step.action === 'training_explain_session') {
    const result = first.result as any;
    return input.locale?.startsWith('pt')
      ? `Sessão de treino: ${result?.title ?? 'sessão'} (${result?.durationMinutes ?? '?'} min), estado ${result?.status ?? 'atual'}.`
      : `Training session: ${result?.title ?? 'session'} (${result?.durationMinutes ?? '?'} min), status ${result?.status ?? 'current'}.`;
  }
  if (first?.step.action === 'training_reflow_preview') {
    return input.locale?.startsWith('pt') ? 'Pré-visualização pronta — encontrei uma janela segura antes de alterar o plano.' : 'Preview ready — I found a safe window before changing the plan.';
  }
  if (first?.step.action === 'training_reflow_confirm') {
    return input.locale?.startsWith('pt') ? 'Feito — reagendei a sessão de treino e verifiquei a alteração.' : 'Done — I reflowed the training session and verified the change.';
  }
  if (first?.step.action === 'training_plan_create') {
    return input.locale?.startsWith('pt')
      ? 'Rascunho pronto — já tenho os dados essenciais para abrir o Training Plan Builder.'
      : 'Draft ready — I have the essential details for the Training Plan Builder.';
  }
  if (first?.step.action?.startsWith('notification_')) {
    return input.locale?.startsWith('pt') ? 'Feito — atualizei e verifiquei a área de notificações.' : 'Done — I updated and verified Notifications.';
  }
  if (first?.step.action?.startsWith('decision_')) {
    return input.locale?.startsWith('pt') ? 'Feito — atualizei a decisão e verifiquei o estado.' : 'Done — I updated the decision and verified its state.';
  }
  return input.locale?.startsWith('pt') ? 'Feito — concluí e verifiquei a ação.' : 'Done — I completed and verified the action.';
}

function verifiedPendingCopy(input: ChatPlannerInput, result: { step: ChatPlanStep; result?: unknown; error?: string }): string {
  if (result.error === 'action_run_reconciliation_pending') {
    return input.locale?.startsWith('pt')
      ? 'Tentei criar isto no teu fornecedor, mas não consegui confirmar. Verifica manualmente para garantir.'
      : "I tried to create this on your provider, but I couldn't confirm it landed. Please verify manually.";
  }
  if (result.step.action === 'training_plan_create') {
    const missing = Array.isArray((result.result as any)?.missingSlots) ? (result.result as any).missingSlots : [];
    if (missing.length > 0) {
      return input.locale?.startsWith('pt')
        ? 'Guardei o rascunho do plano de treino e ainda preciso de mais alguns detalhes.'
        : 'I saved the training plan draft and still need a few details.';
    }
    return input.locale?.startsWith('pt')
      ? 'Rascunho pronto — posso abrir o Training Plan Builder com estes dados.'
      : 'Draft ready — I can open the Training Plan Builder with these details.';
  }
  return input.locale?.startsWith('pt')
    ? 'Guardei o estado e deixei pronto para continuar.'
    : 'I saved the state and it is ready to continue.';
}

function failureCopy(input: ChatPlannerInput, reason?: string): string {
  if (input.locale?.startsWith('pt')) {
    if (reason?.includes('google_calendar_not_connected')) return 'Não consigo criar o evento ainda porque a tua conta Google Calendar não está ligada com permissão de escrita.';
    if (reason?.includes('outlook_calendar_not_connected')) return 'Não consigo criar o evento ainda porque a tua conta Outlook Calendar não está ligada com permissão de escrita.';
    if (reason?.includes('not_connected')) return 'Não consigo fazer isso ainda porque o provedor necessário não está ligado com permissão de escrita.';
    if (reason?.includes('conflict')) return 'Encontrei um conflito no calendário. Queres que eu marque mesmo assim?';
    if (reason?.includes('executor_not_enabled') || reason?.includes('requires_provider') || reason?.includes('requires_preview_contract') || reason?.includes('requires_outbound_confirmation') || reason?.includes('requires_provider_specific')) return 'Ainda não consigo executar essa ação por chat com segurança. Nada foi alterado.';
    if (reason?.includes('read_back')) return 'A ação foi tentada, mas não consegui verificar o resultado. Não vou afirmar sucesso completo.';
    if (reason?.includes('required')) return 'Preciso de mais um detalhe específico antes de executar isto com segurança.';
    return 'Não consegui concluir a ação agora. Nada foi confirmado como feito.';
  }
  if (reason?.includes('google_calendar_not_connected')) return 'I cannot create the event yet because Google Calendar is not connected with write permission.';
  if (reason?.includes('outlook_calendar_not_connected')) return 'I cannot create the event yet because Outlook Calendar is not connected with write permission.';
  if (reason?.includes('not_connected')) return 'I cannot do that yet because the required provider is not connected with write permission.';
  if (reason?.includes('conflict')) return 'I found a calendar conflict. Do you want me to schedule it anyway?';
  if (reason?.includes('executor_not_enabled') || reason?.includes('requires_provider') || reason?.includes('requires_preview_contract') || reason?.includes('requires_outbound_confirmation') || reason?.includes('requires_provider_specific')) return 'I cannot safely run that action from chat yet. Nothing was changed.';
  if (reason?.includes('read_back')) return 'The action was attempted, but I could not verify the result. I will not claim full success.';
  if (reason?.includes('required')) return 'I need one more specific detail before I can do this safely.';
  return 'I could not complete the action right now. Nothing was confirmed as done.';
}

function partialCopy(input: ChatPlannerInput): string {
  return input.locale?.startsWith('pt')
    ? 'Fiz parte do pedido, mas não consegui verificar tudo. Não vou afirmar sucesso completo.'
    : 'I completed part of the request, but could not verify everything. I will not claim full success.';
}

function unsupportedChatExecutorReason(step: ChatPlanStep): string {
  switch (step.action) {
    case 'draft_email':
      return 'email_draft_requires_provider_draft_read_back_contract';
    case 'send_email':
      return 'email_send_requires_outbound_confirmation_and_provider_read_back_contract';
    case 'training_adjust_plan':
      return 'training_plan_adjust_requires_preview_contract_before_chat_execution';
    case 'connections_retry_sync':
      return 'connections_retry_sync_requires_provider_specific_sync_contract';
    default:
      return 'executor_not_enabled_for_chat_yet';
  }
}

function confirmationCopy(plan: ChatActionPlan, input: ChatPlannerInput): string {
  const first = plan.steps[0];
  if (first?.action === 'schedule_event') {
    const args = first.args as any;
    const provider = args.provider === 'outlook_calendar' ? 'Outlook Calendar' : 'Google Calendar';
    const start = DateTime.fromISO(String(args.startDateTime)).setZone(input.timezone);
    const end = DateTime.fromISO(String(args.endDateTime)).setZone(input.timezone);
    const title = typeof args.title === 'string' ? args.title : input.text;
    const attendeeCount = Array.isArray(args.attendees) ? args.attendees.length : 0;
    if (input.locale?.startsWith('pt')) {
      const inviteNote = attendeeCount > 0
        ? ` Isto pode enviar convite para ${attendeeCount} participante(s).`
        : '';
      return `Confirma que queres criar “${title}” no ${provider} em ${start.setLocale('pt').toFormat("cccc, d 'de' LLLL")}, das ${start.toFormat('HH:mm')} às ${end.toFormat('HH:mm')}.${inviteNote}`;
    }
    const inviteNote = attendeeCount > 0
      ? ` This may send an invite to ${attendeeCount} attendee(s).`
      : '';
    return `Confirm that you want to create “${title}” in ${provider} on ${start.toFormat('cccc, LLL d')}, ${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}.${inviteNote}`;
  }
  if (first?.action === 'create_task' || first?.action === 'delete_task' || first?.action === 'complete_task' || first?.action === 'update_task') {
    const title = typeof (first.args as any).title === 'string' ? (first.args as any).title : typeof (first.args as any).taskId === 'string' ? (first.args as any).taskId : input.text;
    if (input.locale?.startsWith('pt')) {
      return `Confirma que queres ${first.action === 'delete_task' ? 'apagar' : first.action === 'complete_task' ? 'concluir' : 'alterar'} a tarefa “${title}”?`;
    }
    return `Confirm that you want to ${first.action === 'delete_task' ? 'delete' : first.action === 'complete_task' ? 'complete' : 'change'} the task “${title}”?`;
  }
  if (input.locale?.startsWith('pt')) {
    return `Preciso da tua confirmação antes de ${first?.action === 'send_email' ? 'enviar' : 'executar'} esta ação.`;
  }
  return `I need your confirmation before I ${first?.action === 'send_email' ? 'send' : 'run'} this action.`;
}

function defaultClarification(input: ChatPlannerInput): string {
  return input.locale?.startsWith('pt') ? 'Preciso só de mais um detalhe para continuar.' : 'I need one more detail before I continue.';
}

// Phase 16 batch 80 (2026-05-16): refusal helpers. Refused plans previously
// shared metadata.type with clarification requests; iOS rendered them
// identically. These helpers route refused plans to distinct copy + a
// dedicated metadata.type so the iOS layer can show a refusal card instead
// of a "needs more info" prompt.
function refusalReasonForPlan(plan: ChatActionPlan): string | null {
  for (const step of plan.steps) {
    const reason = (step.args as { rejectionReason?: unknown })?.rejectionReason;
    if (typeof reason === 'string' && reason.length > 0) return reason;
  }
  return null;
}

function refusalCopyForReason(reason: string, input: ChatPlannerInput): string {
  const locale = input.locale ?? 'en-US';
  const isPt = locale.startsWith('pt');
  const isEs = locale.startsWith('es');
  if (reason === 'prompt_injection_marker_detected') {
    if (isPt) return 'Não vou seguir instruções embutidas em mensagens. Reformule o pedido sem usar comandos como "ignore o anterior".';
    if (isEs) return 'No voy a seguir instrucciones embebidas en mensajes. Reformula la solicitud sin comandos como "ignora lo anterior".';
    return "I won't follow embedded instructions in messages. Try rephrasing without commands like \"ignore previous\".";
  }
  if (reason === 'sensitive_data_exfiltration_detected') {
    if (isPt) return 'Não posso compartilhar esse tipo de detalhe. Posso ajudar com algo mais específico?';
    if (isEs) return 'No puedo compartir ese tipo de detalle. ¿Puedo ayudarte con algo más específico?';
    return "I can't share that kind of detail. Can I help with something more specific?";
  }
  if (reason === 'bulk_destructive_request_detected') {
    if (isPt) return 'Não vou executar isso — afeta itens demais. Tente um escopo menor ou nomeie o item específico.';
    if (isEs) return 'No voy a ejecutarlo — afecta demasiados elementos. Prueba con un alcance más pequeño o nombra el elemento específico.';
    return "I won't run that — it would affect too many items. Try a smaller scope or name the specific item.";
  }
  if (isPt) return 'Não posso seguir com esse pedido.';
  if (isEs) return 'No puedo seguir con esa solicitud.';
  return "I can't proceed with that request.";
}

function domainForPlan(plan: ChatActionPlan): ChatActionRouteResponse['domain'] {
  const skill = plan.steps[0]?.skill;
  if (skill === 'secretary_calendar' || skill === 'mail') return 'secretary';
  if (skill === 'tasks') return 'tasks';
  if (skill === 'training') return 'training';
  if (skill === 'content') return 'content';
  if (skill === 'cooking') return 'cooking';
  if (skill === 'finance') return 'finance';
  return 'unknown';
}

function firstTitle(results: Array<{ step: ChatPlanStep }>): string | undefined {
  const title = (results[0]?.step.args as any)?.title;
  return typeof title === 'string' ? title : undefined;
}

function calendarCardEvents(results: Array<{ step: ChatPlanStep; result?: unknown }>): Array<Record<string, string>> | undefined {
  const calendarSteps = results.filter((result) => result.step.action === 'schedule_event');
  if (calendarSteps.length === 0) return undefined;
  return calendarSteps.map((result) => {
    const args = result.step.args as any;
    const start = DateTime.fromISO(String(args.startDateTime));
    const end = DateTime.fromISO(String(args.endDateTime));
    return {
      title: String(args.title),
      time: `${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}`,
      source: args.provider === 'outlook_calendar' ? 'outlook' : 'google',
    };
  });
}

function resultCardPayload(results: Array<{ step: ChatPlanStep; result?: unknown }>): Record<string, unknown> {
  const first = results[0];
  if (!first) return {};
  if (first.step.action === 'content_brief_create' || first.step.action === 'content_script_create') {
    const result = first.result as any;
    return {
      contentPackage: result ? {
        packageId: result.packageId,
        qualityScore: result.quality?.score ?? null,
        blockers: result.quality?.blockers ?? [],
        warnings: result.quality?.warnings ?? [],
        script: result.firstScript ? {
          title: result.firstScript.title,
          coldOpen: result.firstScript.coldOpen,
          promise: result.firstScript.promise,
          cta: result.firstScript.cta,
        } : null,
      } : null,
    };
  }
  if (first.step.action === 'cooking_grocery_list') {
    const result = first.result as any;
    return { groceryList: result ? { weekStart: result.weekStart, itemCount: result.itemCount, items: result.items } : null };
  }
  if (first.step.action === 'finance_summary') return { finance: first.result ?? null };
  if (first.step.action === 'connections_status') return { connections: first.result ?? null };
  if (first.step.action === 'training_coach_report') return { training: first.result ?? null };
  return {};
}

function actionButtonsForResults(results: Array<{ step: ChatPlanStep }>): string[] {
  const first = results[0]?.step;
  if (!first) return [];
  if (first.action === 'schedule_event') return ['open_provider_event', 'undo_created_event'];
  if (first.action === 'create_task' || first.action === 'create_checklist') return ['open_skill', 'undo'];
  if (first.skill === 'content' || first.skill === 'cooking' || first.skill === 'finance' || first.skill === 'connections' || first.skill === 'training') return ['open_skill'];
  if (first.skill === 'notifications' || first.skill === 'decision_center') return ['open_skill'];
  return [];
}

function openSurfacePayloadForStep(step: ChatPlanStep, result: unknown, input: ChatPlannerInput): Record<string, unknown> | null {
  if (!isChatOpenSurfaceHandoffEnabled(process.env, { userId: input.userId, tenantId: input.tenantId })) return null;
  if (step.action === 'training_plan_create') {
    return {
      surface: 'training_plan_builder',
      pendingActionId: (result as any)?.pendingActionId ?? null,
      prefill: {
        sport: (step.args as any).sport ?? null,
        goal: (step.args as any).goal ?? null,
        durationWeeks: (step.args as any).durationWeeks ?? null,
        startDate: (step.args as any).startDate ?? null,
        weeklyVolumeKm: (step.args as any).weeklyVolumeKm ?? null,
        constraints: (step.args as any).constraints ?? [],
      },
    };
  }
  if (step.skill === 'content') return { surface: 'script_studio', prefill: step.args };
  if (step.skill === 'tasks') return { surface: 'task_detail', prefill: step.args };
  if (step.skill === 'secretary_calendar') return { surface: 'calendar_event', prefill: step.args };
  if (step.skill === 'finance') return { surface: 'finance_review', prefill: step.args };
  if (step.skill === 'cooking') return { surface: 'cooking_meal_plan', prefill: step.args };
  return null;
}

function sanitizeActionResults(results: Array<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }>): Array<Record<string, unknown>> {
  return results.map((result) => ({
    stepId: result.step.stepId,
    skill: result.step.skill,
    action: result.step.action,
    status: result.status,
    provider: result.step.provider,
    title: typeof (result.step.args as any).title === 'string' ? (result.step.args as any).title : undefined,
    error: result.error,
  }));
}

function safeTelemetry(telemetry: ChatActionTelemetry): Record<string, unknown> {
  return {
    routeTier: telemetry.routeTier,
    candidates: telemetry.candidates.slice(0, 4),
    calibratedScore: telemetry.calibratedScore,
    threshold: telemetry.threshold,
    modelProvider: telemetry.modelProvider,
    model: telemetry.model,
    estimatedTokenCostUsd: telemetry.estimatedTokenCostUsd,
    verifierStatus: telemetry.verifierStatus,
    latencyMs: telemetry.latencyMs,
    outcome: telemetry.outcome,
    failureReason: telemetry.failureReason,
    slotProvenanceSummary: telemetry.slotProvenanceSummary,
  };
}

function finalizeTelemetryForResponse(
  plan: ChatActionPlan,
  status: ChatActionStatus,
  metadata: Record<string, unknown>,
  input: ChatPlannerInput,
): ChatActionTelemetry {
  const base = plan.telemetry ?? {
    routeTier: 'tier0_deterministic' as const,
    candidates: plan.steps.map((step) => ({
      skill: step.skill,
      action: step.action,
      score: plan.effectiveConfidence ?? plan.confidence,
    })),
    calibratedScore: plan.effectiveConfidence ?? plan.confidence,
    threshold: thresholdForSteps(plan.steps),
  };
  return {
    ...base,
    verifierStatus: verifierStatusForActionStatus(status, plan),
    latencyMs: input.routeStartedAtMs ? Math.max(0, Date.now() - input.routeStartedAtMs) : base.latencyMs,
    outcome: status,
    failureReason: failureReasonForTelemetry(status, metadata) ?? base.failureReason,
    slotProvenanceSummary: summarizeSlotProvenance(plan),
  };
}

function verifierStatusForActionStatus(status: ChatActionStatus, plan: ChatActionPlan): ChatActionTelemetry['verifierStatus'] {
  const requiresVerification = plan.steps.some((step) => step.verification.required);
  if (!requiresVerification) return 'not_required';
  if (status === 'verified_success') return 'verified';
  if (status === 'verified_pending' || status === 'needs_confirmation' || status === 'needs_clarification' || status === 'planned' || status === 'executing' || status === 'verifying') return 'pending';
  if (status === 'partial_success') return 'mismatch';
  return 'failed';
}

function failureReasonForTelemetry(status: ChatActionStatus, metadata: Record<string, unknown>): string | undefined {
  if (status === 'verified_success' || status === 'verified_pending' || status === 'needs_confirmation' || status === 'needs_clarification') return undefined;
  const actionResults = metadata.actionResults;
  if (Array.isArray(actionResults)) {
    const firstError = actionResults
      .map((result) => result && typeof result === 'object' ? (result as Record<string, unknown>).error : null)
      .find((error): error is string => typeof error === 'string' && error.length > 0);
    if (firstError) return firstError.slice(0, 120);
  }
  const error = metadata.error;
  if (typeof error === 'string') return error.slice(0, 120);
  if (error && typeof error === 'object') {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') return code.slice(0, 120);
  }
  const reason = metadata.reason;
  if (typeof reason === 'string') return reason.slice(0, 120);
  return status;
}

function summarizeSlotProvenance(plan: ChatActionPlan): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const step of plan.steps) {
    if (!step.slotProvenance) continue;
    const stepSummary: Record<string, unknown> = {};
    for (const [slot, provenance] of Object.entries(step.slotProvenance)) {
      stepSummary[slot] = {
        sourceType: provenance.sourceType,
        normalizer: provenance.normalizer,
        confidence: provenance.confidence,
        validation: provenance.validation,
      };
    }
    if (Object.keys(stepSummary).length > 0) {
      summary[`${step.skill}.${step.action}.${step.stepId}`] = stepSummary;
    }
  }
  return summary;
}

function estimatePlannerCallCostUsd(provider: 'gemini' | 'openai', model: string, systemPrompt: string, userPrompt: string, outputText: string): number {
  const inputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
  const outputTokens = estimateTokens(outputText);
  const priced = computeModelUsageCostUsd(model, { inputTokens, outputTokens }, provider);
  if (!priced.pricingResolved) {
    logger.warn({ model, inputTokens, outputTokens }, 'Chat action planner cost estimate has unresolved model pricing');
  }
  return Number(priced.costUsd.toFixed(8));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

// actionToStepType and pickExpectedFields moved to skills/step-builder.ts.

function normalizeProvider(value: unknown): ChatProvider | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'google_calendar' || value === 'outlook_calendar' || value === 'gmail' || value === 'outlook_mail' || value === 'nexus' || value === 'stripe' || value === 'telegram' || value === 'none') {
    return value;
  }
  return undefined;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.4;
  return Math.max(0, Math.min(1, value));
}

function stepRequiresConfirmation(
  step: ChatPlanStep,
  opts: { requireSafeWrites?: boolean } = {},
): boolean {
  if (
    step.risk === 'ambiguous' &&
    step.requiredArgsPresent === false &&
    typeof step.args?.rejectionReason === 'string'
  ) {
    return false;
  }
  const definition = findChatActionDefinition(step.skill, step.action);
  if (opts.requireSafeWrites && step.risk === 'safe_write') return true;
  return ['external_side_effect', 'destructive', 'financial', 'admin_security'].includes(step.risk)
    || definition?.confirmationPolicy === 'confirm'
    || definition?.confirmationPolicy === 'strong_confirm';
}

function intentClassForPlan(plan: ChatActionPlan): string {
  const action = plan.steps[0]?.action;
  switch (action) {
    case 'create_task':
      return 'task_create';
    case 'delete_task':
      return 'task_delete';
    case 'complete_task':
      return 'task_complete';
    case 'update_task':
      return 'task_update';
    case 'schedule_event':
      return 'event_create';
    case 'move_event':
    case 'update_event':
      return 'event_move';
    case 'delete_event':
      return 'event_delete';
    case 'finance_payment_action':
      return 'financial_transfer';
    case 'finance_create_reminder':
    case 'finance_categorize_receipt':
      return 'finance_write';
    case 'send_email':
      return 'email_send';
    default:
      return action ? String(action).replace(/-/g, '_') : 'chat_action';
  }
}

function confirmationVariant(plan: ChatActionPlan): 'default' | 'destructive' | 'financial' {
  if (plan.steps.some((step) => step.risk === 'financial')) return 'financial';
  if (plan.steps.some((step) => step.risk === 'destructive' || step.risk === 'admin_security')) return 'destructive';
  return 'default';
}

function thresholdForSteps(steps: ChatPlanStep[]): number {
  const riskiest = steps.reduce<ChatActionRiskClass>((current, step) => {
    const candidate = step.riskClass ?? riskClassForRisk(step.risk);
    return riskRank(candidate) > riskRank(current) ? candidate : current;
  }, 'R0');
  if (riskiest === 'R3') return 0.98;
  if (riskiest === 'R2') return 0.96;
  if (riskiest === 'R1') return 0.9;
  if (riskiest === 'R4') return 1;
  return 0.75;
}

function calibratePlanConfidence(steps: ChatPlanStep[], baseConfidence: number): number {
  let score = clampConfidence(baseConfidence);
  for (const step of steps) {
    const missingPenalty = step.requiredArgsPresent ? 0 : 0.28;
    const provenancePenalty = provenanceCoverage(step) >= 0.9 ? 0 : 0.08;
    const riskPenalty = step.riskClass === 'R4' ? 0.35 : 0;
    score = Math.min(score, clampConfidence(score - missingPenalty - provenancePenalty - riskPenalty));
  }
  return Number(score.toFixed(3));
}

function provenanceCoverage(step: ChatPlanStep): number {
  const definition = findChatActionDefinition(step.skill, step.action);
  const required = definition?.requiredFields ?? [];
  if (required.length === 0) return 1;
  const provenance = step.slotProvenance ?? {};
  const present = required.filter((field) => step.args[field] != null && step.args[field] !== '');
  if (present.length === 0) return 0;
  const withProvenance = present.filter((field) => provenance[field]?.validation === 'passed');
  return withProvenance.length / present.length;
}

function riskRank(risk: ChatActionRiskClass): number {
  return { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 }[risk];
}

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

function buildLlmSlotProvenance(
  input: ChatPlannerInput,
  args: Record<string, unknown>,
  requiredFields: string[],
  sourceType: ChatSlotProvenance['sourceType'] = 'planner',
  validation?: SlotValidationResult,
): Record<string, ChatSlotProvenance> {
  const provenance: Record<string, ChatSlotProvenance> = {};
  const failedSlots = new Set(Object.keys(validation?.errors ?? {}));
  const missingSlots = new Set(validation?.missing ?? []);
  for (const field of [...new Set([...requiredFields, ...Object.keys(args)])]) {
    if (args[field] == null || args[field] === '') continue;
    provenance[field] = makeSlotProvenance({
      slot: field,
      value: args[field],
      rawText: input.text,
      turnId: input.messageId,
      sourceType,
      normalizer: 'llm_structured_planner_v1',
      confidence: 0.72,
      validation: failedSlots.has(field) || missingSlots.has(field) ? 'failed' : 'passed',
    });
  }
  return provenance;
}

function provenanceSourceForRouteTier(routeTier?: ChatActionTelemetry['routeTier']): ChatSlotProvenance['sourceType'] {
  if (routeTier === 'tier1_classifier') return 'classifier';
  if (routeTier === 'tier3_reviewer') return 'reviewer';
  return 'planner';
}

// inferContentPlatform, inferProviderName, and extractTopic moved to
// skills/text-extractors.ts on 2026-05-15 (planner-split, audit implementation
// plan Phase 0).

function retrievePlannerExamples(input: ChatPlannerInput, registry: ReturnType<typeof getChatActionRegistry>): Array<Record<string, unknown>> {
  const folded = foldCalendarText(input.text);
  const examples: Array<Record<string, unknown>> = [];
  for (const entry of registry) {
    const safe = buildLlmSafePromptSlice(entry);
    for (const example of safe.examples) {
      examples.push({
        skill: safe.skill,
        action: safe.action,
        text: example.text,
        locale: example.locale,
        expectedSlots: example.expectedSlots,
      });
    }
  }
  if (/\b(called|named|titled|chamado|t[ií]tulo)\b/.test(folded)) {
    examples.push({
      text: 'Create a task for tomorrow 9 am called Test chat',
      expected: { skill: 'tasks', action: 'create_task', title: 'Test chat', dueDateTime: 'tomorrow 09:00' },
    });
  }
  if (/\b(agenda do gmail|gmail agenda)\b/.test(folded)) {
    examples.push({
      text: 'Cria um evento na agenda do Gmail chamado igreja das 10 ao meio-dia e meio nesse domingo',
      expected: { skill: 'secretary_calendar', action: 'schedule_event', provider: 'google_calendar', title: 'igreja' },
    });
  }
  if (/\b(km|week|semana)\b/.test(folded) && /\b(training|treino|running|corrida)\b/.test(folded)) {
    examples.push({
      text: 'It is 20 km a week',
      expected: { skill: 'training', action: 'training_plan_create', slot: 'weeklyVolumeKm', value: 20, requiresPendingAction: true },
    });
  }
  const seen = new Set<string>();
  return examples.filter((example) => {
    const key = JSON.stringify(example);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}
