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
  hasMailReadIntent,
  foldCalendarText,
} from './calendar-natural-language-parser';
import {
  findChatActionDefinition,
  getChatActionRegistry,
  messageHasActionCandidate,
  selectRegistrySubsetForMessage,
  type ChatActionName,
  type ChatActionRisk,
  type ChatActionSkill,
  type ChatProvider,
} from './chat-action-registry';
import {
  buildNormalizedActionHash,
  claimChatActionRun,
  listPendingChatActionRuns,
  updateChatActionRun,
  type ChatActionRunRow,
  type ChatActionRunStatus,
} from './chat-action-run-store';
import { invalidateCalendarCaches } from './cache-coherence-registry';
import { getTaskProviderForUser } from './task-store/task-router';
import { resolveTaskCreationList } from './task-store/task-list-resolution';
import { completeOneShotWithFallback } from './gemini-provider';
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

export type ChatActionStatus = ChatActionRunStatus;

export type ChatPlanStepType = ChatActionName | 'answer' | 'clarification';

export interface ChatActionPlan {
  schemaVersion: 1;
  userId: string;
  tenantId: string;
  conversationId: string;
  messageId: string;
  locale: string;
  timezone: string;
  channel: 'ios' | 'telegram' | 'portal' | 'api';
  createdAt: string;
  planner: 'deterministic' | 'llm_structured' | 'mixed';
  steps: ChatPlanStep[];
  requiresConfirmation: boolean;
  clarificationQuestion?: string;
  confidence: number;
  debug?: {
    routingSignals: string[];
    rejectedFastPaths: string[];
    parser: 'deterministic' | 'model_assisted' | 'mixed';
    modelProvider?: 'gemini' | 'anthropic' | 'openai';
  };
}

export interface ChatPlanStep {
  stepId: string;
  skill: ChatActionSkill;
  type: ChatPlanStepType;
  action: ChatActionName;
  risk: ChatActionRisk;
  provider?: ChatProvider;
  args: Record<string, unknown>;
  requiredArgsPresent: boolean;
  idempotencyKey: string;
  dependsOnStepIds?: string[];
  verification: {
    required: boolean;
    method: 'provider_read_back' | 'local_read_back' | 'none';
    expectedFields?: Record<string, unknown>;
  };
}

export interface ChatPlannerInput {
  text: string;
  userId: number;
  tenantId: number;
  conversationId: string;
  messageId: string;
  channel: 'ios' | 'telegram' | 'portal' | 'api';
  locale?: string;
  timezone: string;
  nowIso?: string;
  persistRuns?: boolean;
}

export interface ChatActionRouteResponse {
  id: string;
  text: string;
  domain: 'secretary' | 'tasks' | 'training' | 'content' | 'cooking' | 'finance' | 'unknown';
  routeMethod: string;
  confidence: number;
  buttons: null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

type CalendarProviderDeps = {
  createEvent: typeof createEvent;
  getEventsForSources: typeof getEventsForSources;
  hasGoogle: typeof isGoogleCalendarConfigured;
  hasOutlook: typeof isOutlookCalendarConfigured;
};

export interface ChatActionPlannerDeps {
  calendar?: CalendarProviderDeps;
  taskProviderForUser?: typeof getTaskProviderForUser;
}

interface ChatActionExecutionOptions {
  confirmed?: boolean;
}

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
    && /\b(cria|criar|adiciona|adicionar|create|add)\b/.test(folded)
    && /\b(task|tarefa|todo|lembrete)\b/.test(folded);
}

export function shouldRunActionPlannerBeforeReadOnlyFastPaths(text: string): boolean {
  if (!text.trim()) return false;
  if (!hasCalendarWriteIntent(text) && hasLegacySubtaskIntent(text)) {
    return false;
  }
  if (hasCalendarWriteIntent(text)) return true;
  if (hasSimpleTaskWriteIntent(text)) return true;
  const folded = foldCalendarText(text);
  if (hasMailReadIntent(text) && !messageHasActionCandidate(text)) return false;
  return messageHasActionCandidate(text) && (
    /\b(send|enviar|reply|responder|publish|publicar|delete|apagar|cancel|cancelar|remove|remover|paga|pay|stripe|refund|reembolso|admin|security|seguranca|revogar|revoke)\b/.test(folded)
    || /\b(script|roteiro|brief|conteudo|content|meal|refeicao|compras|grocery|finance|orcamento|budget|conexao|connection|notificacao|notification|decision|decisao|treino|training)\b/.test(folded)
  );
}

export async function tryHandleChatActionPlan(
  input: ChatPlannerInput,
  deps: ChatActionPlannerDeps = {},
): Promise<{ plan: ChatActionPlan; response: ChatActionRouteResponse; status: ChatActionStatus } | null> {
  if (!shouldRunActionPlannerBeforeReadOnlyFastPaths(input.text)) return null;
  const plan = await buildChatActionPlan(input);
  if (!plan) return null;
  const resolvedDeps = { ...DEFAULT_DEPS, ...deps };
  const response = await executeChatActionPlan(plan, input, resolvedDeps);
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
  const deterministic = buildDeterministicChatActionPlan(input);
  if (deterministic) return deterministic;

  const folded = foldCalendarText(input.text);
  const looksComplex = /(?:\be\b|\band\b|\+|,).{8,}/.test(folded) || selectRegistrySubsetForMessage(input.text).length > 1;
  if (looksComplex || messageHasActionCandidate(input.text)) {
    const llmPlan = await tryBuildLlmStructuredPlan(input);
    if (llmPlan) return llmPlan;
  }

  if (messageHasActionCandidate(input.text)) {
    return buildClarificationPlan(input, input.locale?.startsWith('pt')
      ? 'Preciso só de mais detalhes para fazer isso. Qual é o título, data, hora e destino?'
      : 'I need a few more details to do that. What title, date, time, and destination should I use?');
  }
  return null;
}

export function buildDeterministicChatActionPlan(input: ChatPlannerInput): ChatActionPlan | null {
  const locale = input.locale || 'pt-BR';
  const nowIso = input.nowIso ?? new Date().toISOString();
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
      provider,
      args,
      requiredArgsPresent: true,
      idempotencyKey: buildNormalizedActionHash({ action: 'schedule_event', args }),
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
      requiresConfirmation: steps.some((candidate) => candidate.risk !== 'safe_write'),
      confidence: calendar.confidence,
      debug: {
        routingSignals: ['calendar_write_intent', provider, 'deterministic_calendar_parser', ...(taskFollowUp ? ['task_follow_up_intent'] : [])],
        rejectedFastPaths: hasMailReadIntent(input.text) ? [] : ['gmail_unread_count'],
        parser: 'deterministic',
      },
    };
  }

  if (hasLegacySubtaskIntent(input.text)) return null;
  const task = parseSimpleTaskIntent(input);
  if (task) return task;
  const broadAction = parseBroadSkillActionIntent(input);
  if (broadAction) return broadAction;
  return null;
}

function parseBroadSkillActionIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  const locale = input.locale || 'pt-BR';
  const now = DateTime.fromISO(input.nowIso ?? new Date().toISOString()).setZone(input.timezone);

  const contentStep = parseContentActionStep(input, folded);
  if (contentStep) return buildPlanFromSteps(input, [contentStep], ['content_action_intent', 'deterministic_skill_parser'], 0.78);

  const cookingStep = parseCookingActionStep(input, folded, now);
  if (cookingStep) return buildPlanFromSteps(input, [cookingStep], ['cooking_action_intent', 'deterministic_skill_parser'], 0.76);

  const financeStep = parseFinanceActionStep(input, folded, now);
  if (financeStep) return buildPlanFromSteps(input, [financeStep], ['finance_action_intent', 'deterministic_skill_parser'], 0.75);

  const connectionsStep = parseConnectionsActionStep(input, folded);
  if (connectionsStep) return buildPlanFromSteps(input, [connectionsStep], ['connections_action_intent', 'deterministic_skill_parser'], 0.74);

  const trainingStep = parseTrainingActionStep(input, folded);
  if (trainingStep) return buildPlanFromSteps(input, [trainingStep], ['training_action_intent', 'deterministic_skill_parser'], 0.72);

  const notificationStep = parseNotificationActionStep(input, folded);
  if (notificationStep) return buildPlanFromSteps(input, [notificationStep], ['notification_action_intent', 'deterministic_skill_parser'], 0.7);

  const decisionStep = parseDecisionActionStep(input, folded);
  if (decisionStep) return buildPlanFromSteps(input, [decisionStep], ['decision_action_intent', 'deterministic_skill_parser'], 0.7);

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

function parseContentActionStep(input: ChatPlannerInput, folded: string): ChatPlanStep | null {
  if (!/\b(content|conteudo|script|roteiro|brief|reel|tiktok|youtube|post|video)\b/.test(folded)) return null;
  const platform = inferContentPlatform(folded);
  const topic = extractTopic(input.text) || input.text.trim();
  if (/\b(script|roteiro)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'content',
      action: 'content_script_create',
      risk: 'safe_write',
      provider: 'nexus',
      args: {
        topic,
        platform,
        format: platform === 'youtube' ? 'long_form_video' : platform === 'carousel' ? 'carousel' : 'short_form_video',
        objective: 'Create a usable creator script from chat.',
      },
      requiredArgsPresent: Boolean(topic && platform !== 'generic'),
    });
  }
  if (/\b(brief|campanha|campaign|ideia|idea|conteudo|content)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'content',
      action: 'content_brief_create',
      risk: 'safe_write',
      provider: 'nexus',
      args: {
        objective: topic,
        goal: topic,
        platform,
        format: platform === 'youtube' ? 'long_form_video' : platform === 'carousel' ? 'carousel' : 'short_form_video',
        audience: null,
      },
      requiredArgsPresent: Boolean(topic && platform !== 'generic'),
    });
  }
  return null;
}

function parseCookingActionStep(input: ChatPlannerInput, folded: string, now: DateTime): ChatPlanStep | null {
  if (!/\b(cooking|cozinha|meal|refeicao|refeicoes|grocery|compras|shopping|comida|fueling)\b/.test(folded)) return null;
  const nextWeek = /\b(next week|proxima semana|próxima semana)\b/.test(folded);
  const weekStart = now.plus({ weeks: nextWeek ? 1 : 0 }).startOf('week').toISODate();
  if (/\b(grocery|shopping list|lista de compras|compras)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'cooking',
      action: 'cooking_grocery_list',
      risk: 'safe_write',
      provider: 'nexus',
      args: { weekStart },
      requiredArgsPresent: Boolean(weekStart),
    });
  }
  if (/\b(meal plan|plano de refeicoes|plano de refeições|ementa)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'cooking',
      action: 'cooking_meal_plan',
      risk: 'safe_write',
      provider: 'nexus',
      args: { dateRange: nextWeek ? 'next_week' : 'this_week', rawRequest: input.text },
      requiredArgsPresent: false,
    });
  }
  return makeStep(input, {
    skill: 'cooking',
    action: /\b(fuel|fueling|pre treino|pre-treino)\b/.test(folded) ? 'cooking_fueling_support' : 'cooking_meal_support',
    risk: 'read_only',
    provider: 'nexus',
    args: { mealContext: input.text },
    requiredArgsPresent: true,
  });
}

function parseFinanceActionStep(input: ChatPlannerInput, folded: string, now: DateTime): ChatPlanStep | null {
  if (!/\b(finance|financas|finanças|budget|orcamento|orçamento|fatura|invoice|pagamento|payment|stripe|gastei|spend|recibo)\b/.test(folded)) return null;
  if (/\b(pay|paga|payment|pagamento|stripe|refund|reembolso|invoice action)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'finance',
      action: 'finance_payment_action',
      risk: 'financial',
      provider: 'stripe',
      args: { rawRequest: input.text },
      requiredArgsPresent: false,
    });
  }
  if (/\b(reminder|lembrete)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'finance',
      action: 'finance_create_reminder',
      risk: 'safe_write',
      provider: 'nexus',
      args: { title: extractTopic(input.text) || input.text.trim(), dueDate: null },
      requiredArgsPresent: false,
    });
  }
  return makeStep(input, {
    skill: 'finance',
    action: 'finance_summary',
    risk: 'read_only',
    provider: 'nexus',
    args: { month: now.toFormat('yyyy-MM') },
    requiredArgsPresent: true,
  });
}

function parseConnectionsActionStep(input: ChatPlannerInput, folded: string): ChatPlanStep | null {
  if (!/\b(connection|connections|conexao|conexoes|ligacao|ligacoes|sync|sincroniza|reconnect|reconectar|google|outlook|garmin)\b/.test(folded)) return null;
  const provider = inferProviderName(folded);
  if (/\b(retry|sincroniza|sync|reconnect|reconectar|refresh)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'connections',
      action: 'connections_retry_sync',
      risk: 'safe_write',
      provider: 'nexus',
      args: { provider },
      requiredArgsPresent: Boolean(provider),
    });
  }
  return makeStep(input, {
    skill: 'connections',
    action: 'connections_status',
    risk: 'read_only',
    provider: 'nexus',
    args: { provider },
    requiredArgsPresent: true,
  });
}

function parseTrainingActionStep(input: ChatPlannerInput, folded: string): ChatPlanStep | null {
  if (!/\b(training|treino|plano de treino|coach|corrida|gym|ginasio|ginásio|session|sessao|sessão|reflow|ajusta|adjust)\b/.test(folded)) return null;
  if (/\b(reflow|remarca|reagenda|adjust|ajusta|alterar plano|muda o plano)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'training',
      action: 'training_adjust_plan',
      risk: 'safe_write',
      provider: 'nexus',
      args: { changeRequest: input.text, planId: null },
      requiredArgsPresent: false,
    });
  }
  if (/\b(coach|report|relatorio|relatório|briefing)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'training',
      action: 'training_coach_report',
      risk: 'read_only',
      provider: 'nexus',
      args: { dateRange: 'current' },
      requiredArgsPresent: true,
    });
  }
  return makeStep(input, {
    skill: 'training',
    action: 'training_explain_session',
    risk: 'read_only',
    provider: 'nexus',
    args: { sessionId: null, rawRequest: input.text },
    requiredArgsPresent: false,
  });
}

function parseNotificationActionStep(input: ChatPlannerInput, folded: string): ChatPlanStep | null {
  if (!/\b(notification|notificacao|notificação|alerta|push)\b/.test(folded)) return null;
  return makeStep(input, {
    skill: 'notifications',
    action: /\b(preference|preferencia|preferência|desativa|disable|ativa|enable)\b/.test(folded)
      ? 'notification_update_preference'
      : 'notification_create_intent',
    risk: 'safe_write',
    provider: 'nexus',
    args: { title: extractTopic(input.text) || input.text.trim(), trigger: null },
    requiredArgsPresent: false,
  });
}

function parseDecisionActionStep(input: ChatPlannerInput, folded: string): ChatPlanStep | null {
  if (!/\b(decision|decisao|decisão|escolha|snooze|adiar|dismiss|dispensar)\b/.test(folded)) return null;
  const decisionId = input.text.match(/\b(?:decision|decis[aã]o)\s*#?:?\s*([a-zA-Z0-9._:-]+)/i)?.[1] ?? null;
  const action: ChatActionName = /\b(snooze|adiar)\b/.test(folded)
    ? 'decision_snooze'
    : /\b(dismiss|dispensar|ignorar)\b/.test(folded)
      ? 'decision_dismiss'
      : 'decision_follow_up';
  return makeStep(input, {
    skill: 'decision_center',
    action,
    risk: action === 'decision_follow_up' ? 'safe_write' : 'safe_write',
    provider: 'nexus',
    args: { decisionId, until: action === 'decision_snooze' ? null : undefined },
    requiredArgsPresent: Boolean(decisionId),
  });
}

function buildPlanFromSteps(input: ChatPlannerInput, steps: ChatPlanStep[], routingSignals: string[], confidence: number): ChatActionPlan {
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
    requiresConfirmation: steps.some(stepRequiresConfirmation),
    clarificationQuestion: steps.some((step) => !step.requiredArgsPresent)
      ? buildTargetedClarificationQuestion(input, steps)
      : undefined,
    confidence,
    debug: {
      routingSignals,
      rejectedFastPaths: [],
      parser: 'deterministic',
    },
  };
}

function makeStep(
  input: ChatPlannerInput,
  opts: {
    skill: ChatActionSkill;
    action: ChatActionName;
    risk: ChatActionRisk;
    provider?: ChatProvider;
    args: Record<string, unknown>;
    requiredArgsPresent: boolean;
  },
): ChatPlanStep {
  const definition = findChatActionDefinition(opts.skill, opts.action);
  return {
    stepId: `step-${randomUUID()}`,
    skill: opts.skill,
    type: actionToStepType(opts.action),
    action: opts.action,
    risk: opts.risk,
    provider: opts.provider ?? definition?.providerDependencies[0] ?? 'nexus',
    args: opts.args,
    requiredArgsPresent: opts.requiredArgsPresent,
    idempotencyKey: buildNormalizedActionHash({ action: opts.action, args: opts.args }),
    verification: {
      required: definition?.verifier !== 'none',
      method: definition?.verifier ?? 'none',
      expectedFields: pickExpectedFields(opts.args, definition?.requiredFields ?? []),
    },
  };
}

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
]);

function sanitizePlannerArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizePlannerArgValue(args);
  return isRecord(sanitized) ? sanitized : {};
}

function sanitizePlannerArgValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePlannerArgValue(item));
  }
  if (!isRecord(value)) return value;

  const sanitized: Record<string, unknown> = {};
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
  if (!/\b(cria|criar|adiciona|adicionar|create|add)\b/.test(folded) || !/\b(task|tarefa|todo|lembrete)\b/.test(folded)) return null;
  const titleMatch = text.match(/\b(?:tarefa|task|todo|lembrete)\s+(?:para\s+|chamad[oa]\s+|called\s+|named\s+)?["“]?(.+?)["”]?(?=$|[,.!?])/i);
  const title = titleMatch?.[1]?.trim();
  if (!title) return null;
  const args = { title, list: null, dueDateTime: null, notes: null };
  return {
    stepId: `step-${randomUUID()}`,
    skill: 'tasks',
    type: 'create_task',
    action: 'create_task',
    risk: 'safe_write',
    provider: 'nexus',
    args,
    requiredArgsPresent: true,
    idempotencyKey: buildNormalizedActionHash({ action: 'create_task', args }),
    verification: {
      required: true,
      method: 'local_read_back',
      expectedFields: { title },
    },
  };
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
      provider: 'none',
      args: {},
      requiredArgsPresent: false,
      idempotencyKey: buildNormalizedActionHash({ action: 'clarification', text: input.text }),
      verification: { required: false, method: 'none' },
    }],
    requiresConfirmation: false,
    clarificationQuestion: question,
    confidence: 0.4,
  };
}

export function buildLlmPlannerPrompt(input: ChatPlannerInput): { systemPrompt: string; userPrompt: string } {
  const subset = selectRegistrySubsetForMessage(input.text);
  const registry = subset.length > 0 ? subset : getChatActionRegistry().filter((entry) => entry.skill === 'tasks' || entry.skill === 'secretary_calendar');
  return {
    systemPrompt: [
      'You convert Nexus chat messages into a compact JSON action plan proposal.',
      'Return JSON only. Do not execute anything. Do not invent userId, tenantId, provider objects, or success.',
      'Use only these actions and required fields. Mark missing fields explicitly.',
      JSON.stringify(registry.map((entry) => ({
        skill: entry.skill,
        action: entry.action,
        requiredFields: entry.requiredFields,
        optionalFields: entry.optionalFields,
        risk: entry.risk,
        confirmationPolicy: entry.confirmationPolicy,
      }))),
    ].join('\n'),
    userPrompt: JSON.stringify({
      text: input.text,
      locale: input.locale || 'pt-BR',
      timezone: input.timezone,
      now: input.nowIso ?? new Date().toISOString(),
      expectedShape: {
        steps: [{ skill: 'tasks', action: 'create_task', args: {}, missingFields: [], confidence: 0.0 }],
        confidence: 0.0,
      },
    }),
  };
}

export function parseLlmPlannerJson(raw: string, input: ChatPlannerInput): ChatActionPlan | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (!fence) return null;
    try { parsed = JSON.parse(fence[1]); } catch { return null; }
  }
  if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
  const steps: ChatPlanStep[] = [];
  for (const candidate of parsed.steps.slice(0, 5)) {
    const skill = candidate.skill as ChatActionSkill;
    const action = candidate.action as ChatActionName;
    const definition = findChatActionDefinition(skill, action);
    if (!definition) return null;
    const args = sanitizePlannerArgs(typeof candidate.args === 'object' && candidate.args ? candidate.args as Record<string, unknown> : {});
    const missing = Array.isArray(candidate.missingFields)
      ? candidate.missingFields.filter((field: unknown): field is string => typeof field === 'string')
      : definition.requiredFields.filter((field) => args[field] == null || args[field] === '');
    const risk = definition.risk;
    steps.push({
      stepId: `step-${randomUUID()}`,
      skill,
      type: actionToStepType(action),
      action,
      risk,
      provider: normalizeProvider(args.provider),
      args,
      requiredArgsPresent: missing.length === 0,
      idempotencyKey: buildNormalizedActionHash({ action, args }),
      verification: {
        required: definition.verifier !== 'none',
        method: definition.verifier,
        expectedFields: pickExpectedFields(args, definition.requiredFields),
      },
    });
  }
  const requiresConfirmation = steps.some(stepRequiresConfirmation);
  const needsClarification = steps.some((step) => !step.requiredArgsPresent);
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
    confidence: clampConfidence(Number(parsed.confidence ?? Math.min(...steps.map((step) => step.requiredArgsPresent ? 0.72 : 0.45)))),
    debug: {
      routingSignals: ['llm_structured_planner'],
      rejectedFastPaths: [],
      parser: 'model_assisted',
    },
  };
}

async function tryBuildLlmStructuredPlan(input: ChatPlannerInput): Promise<ChatActionPlan | null> {
  const prompt = buildLlmPlannerPrompt(input);
  try {
    const result = await completeOneShotWithFallback(
      prompt.systemPrompt,
      prompt.userPrompt,
      'chat_action_planner',
      async () => { throw new Error('anthropic_action_planner_disabled'); },
      { temperature: 0, maxTokens: 900, jsonMode: true, userId: input.userId, tenantId: input.tenantId, timeoutMs: 3500 },
    );
    const plan = parseLlmPlannerJson(result.text, input);
    if (plan?.debug) plan.debug.modelProvider = result.provider;
    return plan;
  } catch (err) {
    logger.debug({ err, userId: input.userId, tenantId: input.tenantId }, 'chat action llm structured planner unavailable');
    return null;
  }
}

export async function executeChatActionPlan(
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  deps: Required<ChatActionPlannerDeps>,
  options: ChatActionExecutionOptions = {},
): Promise<ChatActionRouteResponse> {
  if (plan.clarificationQuestion || plan.steps.some((step) => !step.requiredArgsPresent)) {
    persistPlanStatus(plan, input, 'needs_clarification');
    return buildActionResponse(input, plan, 'needs_clarification', plan.clarificationQuestion || defaultClarification(input), {
      type: 'chat_action_needs_input',
      actionStatus: 'needs_clarification',
      clarification: { question: plan.clarificationQuestion || defaultClarification(input), reason: 'missing_required_fields' },
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
      },
    });
  }

  const results: Array<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> = [];
  for (const step of plan.steps) {
    if (step.dependsOnStepIds?.some((dep) => results.some((result) => result.step.stepId === dep && result.status !== 'verified_success'))) {
      results.push({ step, status: 'blocked', error: 'dependency_failed' });
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
    updateChatActionRun(claim.row.id, status, {
      error: status === 'needs_clarification' ? { reason: 'missing_required_fields' } : undefined,
      verification: status === 'needs_confirmation' ? { required: true, reason: 'risk_policy' } : undefined,
    });
  }
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

  const conflicts = await calendar.getEventsForSources(args.startDateTime, args.endDateTime, input.userId, [provider as CalendarSource])
    .catch(() => [] as UnifiedCalendarEvent[]);
  if (!confirmed && conflicts.some((event) => overlaps(args.startDateTime, args.endDateTime, event.start, event.end))) {
    return { step, status: 'needs_confirmation', error: 'calendar_conflict_requires_confirmation' };
  }

  const claim = persistRuns
    ? claimChatActionRun({
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
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return {
      step,
      status: 'verified_success',
      result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true, providerObjectId: claim.row.provider_object_id },
    };
  }
  if (claim) updateChatActionRun(claim.row.id, 'executing');

  try {
    const created = await calendar.createEvent({
      title: String(args.title),
      start: String(args.startDateTime),
      end: String(args.endDateTime),
      attendees: confirmed && Array.isArray(args.attendees)
        ? args.attendees.filter((attendee: unknown): attendee is string => typeof attendee === 'string')
        : [],
      location: typeof args.location === 'string' ? args.location : undefined,
      description: typeof args.notes === 'string' ? args.notes : undefined,
      recurrence: args.recurrence ?? undefined,
    }, provider as CalendarSource, input.userId);
    if (claim) updateChatActionRun(claim.row.id, 'verifying', { result: created, providerObjectId: created.id ?? null });
    const readBack = await calendar.getEventsForSources(args.startDateTime, args.endDateTime, input.userId, [provider as CalendarSource]);
    const verified = readBack.find((event) => calendarEventMatches(event, {
      title: String(args.title),
      start: String(args.startDateTime),
      end: String(args.endDateTime),
      source: provider as CalendarSource,
      id: created.id,
    }));
    if (!verified) {
      if (claim) updateChatActionRun(claim.row.id, 'partial_success', {
        providerObjectId: created.id ?? null,
        verification: { verified: false, reason: 'provider_read_back_mismatch' },
      });
      return { step, status: 'partial_success', result: { created, verified: false }, error: 'provider_read_back_mismatch' };
    }
    invalidateCalendarCaches(input.userId);
    const result = { event: verified, providerObjectId: created.id, verified: true };
    if (claim) updateChatActionRun(claim.row.id, 'verified_success', {
      result,
      providerObjectId: created.id ?? verified.id ?? null,
      verification: {
        verified: true,
        expected: step.verification.expectedFields,
        actual: { title: (verified as any).title || verified.summary, start: verified.start, end: verified.end, provider: verified.source },
      },
    });
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
  const claim = claimActionRunForStep(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim) updateChatActionRun(claim.row.id, 'executing');

  try {
    const updatePayload = {
      event_id: eventId,
      new_start: typeof args.startDateTime === 'string' ? args.startDateTime : typeof args.newStartDateTime === 'string' ? args.newStartDateTime : undefined,
      new_end: typeof args.endDateTime === 'string' ? args.endDateTime : typeof args.newEndDateTime === 'string' ? args.newEndDateTime : undefined,
      new_title: typeof args.title === 'string' ? args.title : typeof args.newTitle === 'string' ? args.newTitle : undefined,
      new_description: typeof args.notes === 'string' ? args.notes : typeof args.description === 'string' ? args.description : undefined,
    };
    const updated = await updateEvent(updatePayload, source, input.userId);
    if (claim) updateChatActionRun(claim.row.id, 'verifying', { result: updated, providerObjectId: updated.id ?? eventId });
    const readStart = updatePayload.new_start || updated.start;
    const readEnd = updatePayload.new_end || updated.end;
    const readBack = readStart && readEnd
      ? await getEventsForSources(readStart, readEnd, input.userId, [source])
      : [];
    const verified = readBack.some((event) => event.id === (updated.id ?? eventId));
    const result = { event: updated, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (claim) updateChatActionRun(claim.row.id, status, {
      result,
      providerObjectId: updated.id ?? eventId,
      verification: { verified, expected: step.verification.expectedFields },
    });
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

  const claim = claimActionRunForStep(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim) updateChatActionRun(claim.row.id, 'executing');

  try {
    await deleteEvent(eventId, source, input.userId);
    if (claim) updateChatActionRun(claim.row.id, 'verifying', { providerObjectId: eventId });
    const readBack = await getEventsForSources(readStart, readEnd, input.userId, [source]);
    const verified = !readBack.some((event) => event.id === eventId);
    const result = { eventId, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (claim) updateChatActionRun(claim.row.id, status, {
      result,
      providerObjectId: eventId,
      verification: { verified, expected: { eventId, absentInWindow: { start: readStart, end: readEnd } } },
    });
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
    ? claimChatActionRun({
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
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim) updateChatActionRun(claim.row.id, 'executing');

  try {
    const list = await resolveTaskCreationList(provider, typeof args.list === 'string' ? args.list : null);
    if (!list?.id) throw new Error('missing_task_list');
    const created = await provider.createTask(String(list.id), list.displayName || list.name || 'Tasks', {
      title: String(args.title),
      body: typeof args.notes === 'string' ? args.notes : undefined,
      dueDateTime: typeof args.dueDateTime === 'string' ? args.dueDateTime : undefined,
    });
    if (!created?.success || !created.data?.id) throw new Error('task_create_failed');
    const readBack = typeof provider.getTask === 'function'
      ? await provider.getTask(String(list.id), String(created.data.id), list.displayName || list.name || 'Tasks')
      : null;
    const verified = !readBack || (readBack.success !== false && String(readBack.data?.title || readBack.data?.subject || created.data.title || '').trim() === String(args.title).trim());
    const result = { task: created.data, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (claim) updateChatActionRun(claim.row.id, status, {
      result,
      providerObjectId: String(created.data.id),
      verification: { verified, expected: step.verification.expectedFields },
    });
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
  const claim = claimActionRunForStep(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim) updateChatActionRun(claim.row.id, 'executing');

  try {
    if (step.action === 'create_checklist') {
      if (typeof provider.createTask !== 'function') throw new Error('task_provider_not_writable');
      const list = await resolveTaskCreationList(provider, typeof args.list === 'string' ? args.list : null);
      if (!list?.id) throw new Error('missing_task_list');
      const created = await provider.createTask(String(list.id), list.displayName || list.name || 'Tasks', {
        title: String(args.title),
        body: typeof args.notes === 'string' ? args.notes : undefined,
      });
      if (!created?.success || !created.data?.id) throw new Error('task_create_failed');
      const items = Array.isArray(args.items) ? args.items.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0) : [];
      const added: unknown[] = [];
      for (const item of items) {
        if (typeof provider.addChecklistItem !== 'function') break;
        const addedItem = await provider.addChecklistItem(String(list.id), String(created.data.id), item);
        added.push(addedItem?.data ?? addedItem);
      }
      const verified = items.length === 0 || added.length === items.length;
      const result = { task: created.data, checklistItems: added, verified };
      const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
      if (claim) updateChatActionRun(claim.row.id, status, { result, providerObjectId: String(created.data.id), verification: { verified } });
      return { step, status, result, error: verified ? undefined : 'checklist_provider_partial' };
    }

    const target = await resolveTaskMutationTarget(provider, args);
    if (!target) return { step, status: 'blocked', error: 'task_target_not_found_or_ambiguous' };
    if (step.action === 'complete_task') {
      if (typeof provider.completeTask !== 'function') throw new Error('task_provider_cannot_complete');
      await provider.completeTask(target.listId, target.taskId);
    } else if (step.action === 'delete_task') {
      if (typeof provider.deleteTask !== 'function') throw new Error('task_provider_cannot_delete');
      await provider.deleteTask(target.listId, target.taskId);
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
      await provider.updateTask(target.listId, target.taskId, updates, target.listName);
    }

    const readBack = typeof provider.getTask === 'function'
      ? await provider.getTask(target.listId, target.taskId, target.listName)
      : null;
    const verified = step.action === 'delete_task'
      ? !readBack || readBack.success === false || !readBack.data
      : !readBack || readBack.success !== false;
    const result = { taskId: target.taskId, listId: target.listId, verified, task: readBack?.data ?? null };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (claim) updateChatActionRun(claim.row.id, status, {
      result,
      providerObjectId: target.taskId,
      verification: { verified, expected: step.verification.expectedFields },
    });
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
  const claim = persistRuns ? claimChatActionRun({
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
  if (claim) updateChatActionRun(claim.row.id, 'executing');

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
    if (claim) updateChatActionRun(claim.row.id, status, {
      result,
      providerObjectId: pkg.id,
      verification: { verified, expected: { packageId: pkg.id } },
    });
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
  const claim = claimActionRunForStep(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim) updateChatActionRun(claim.row.id, 'executing');
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
    if (claim) updateChatActionRun(claim.row.id, status, {
      result,
      providerObjectId: String(topic.id),
      verification: { verified, expected: { title, date: dateTime.toISODate() } },
    });
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
  const claim = claimActionRunForStep(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim) updateChatActionRun(claim.row.id, 'executing');
  try {
    const handoff = handoffContentAgencyPackageToPipeline({
      userId: input.userId,
      tenantId: input.tenantId,
      packageId,
    });
    const verified = handoff.status === 'created' || handoff.status === 'already_exists';
    const status: ChatActionRunStatus = verified ? 'verified_success' : handoff.status === 'blocked' ? 'blocked' : 'failed';
    if (claim) updateChatActionRun(claim.row.id, status, {
      result: handoff,
      providerObjectId: handoff.pipelineId != null ? String(handoff.pipelineId) : packageId,
      verification: { verified, expected: { packageId }, actual: { status: handoff.status, pipelineId: handoff.pipelineId } },
      error: verified ? undefined : { reason: handoff.blockers[0] ?? handoff.status },
    });
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
  const claim = persistRuns ? claimChatActionRun({
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
  if (claim) updateChatActionRun(claim.row.id, 'executing');
  try {
    const list = generateShoppingList(input.userId, weekStart, input.tenantId);
    const readBack = getShoppingList(input.userId, weekStart, input.tenantId);
    const verified = readBack?.week_start === list.week_start;
    const result = { weekStart, itemCount: list.items.length, items: list.items.slice(0, 12), verified: Boolean(verified) };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (claim) updateChatActionRun(claim.row.id, status, {
      result,
      providerObjectId: `shopping-list:${weekStart}`,
      verification: { verified, expected: { weekStart } },
    });
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
  const claim = claimActionRunForStep(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim) updateChatActionRun(claim.row.id, 'executing');
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
    if (claim) updateChatActionRun(claim.row.id, status, {
      result,
      providerObjectId: String(meal.id),
      verification: { verified, expected: { date, mealType, title } },
    });
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
    const summary = getMonthlySummary(input.userId, month);
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
  const claim = claimActionRunForStep(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim) updateChatActionRun(claim.row.id, 'executing');
  try {
    const updated = updateTransactionCategory(input.userId, transactionId, category, {
      subcategory: typeof args.subcategory === 'string' ? args.subcategory : null,
    });
    if (!updated) {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', { error: { reason: 'finance_transaction_not_found_or_unauthorized' } });
      return { step, status: 'blocked', error: 'finance_transaction_not_found_or_unauthorized' };
    }
    const verified = updated.category === category;
    const result = { transactionId, category: updated.category, subcategory: updated.subcategory, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (claim) updateChatActionRun(claim.row.id, status, {
      result,
      providerObjectId: String(transactionId),
      verification: { verified, expected: { transactionId, category } },
    });
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
  const claim = claimActionRunForStep(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim) updateChatActionRun(claim.row.id, 'executing');
  try {
    const ok = markTaxPaid(input.userId, month);
    if (!ok) {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', { error: { reason: 'finance_tax_event_not_found_or_unauthorized' } });
      return { step, status: 'blocked', error: 'finance_tax_event_not_found_or_unauthorized' };
    }
    const year = Number(month.slice(0, 4));
    const readBack = getTaxEvents(input.userId, { year, limit: 24 }).find((event) => event.month === month);
    const verified = readBack?.status === 'paid';
    const result = { month, status: readBack?.status ?? null, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (claim) updateChatActionRun(claim.row.id, status, {
      result,
      providerObjectId: `finance_tax_event:${month}`,
      verification: { verified, expected: { month, status: 'paid' } },
    });
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
  const claim = claimActionRunForStep(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim) updateChatActionRun(claim.row.id, 'executing');
  try {
    if (step.action === 'training_reflow_preview') {
      const preview = await previewTrainingSessionReflow(input.userId, sessionId, source);
      const verified = preview.status === 'preview';
      const status: ChatActionRunStatus = verified ? 'verified_success' : preview.status === 'blocked' || preview.status === 'forbidden' || preview.status === 'no_calendar' ? 'blocked' : 'failed';
      if (claim) updateChatActionRun(claim.row.id, status, {
        result: preview,
        providerObjectId: String(sessionId),
        verification: { verified, expected: { sessionId } },
      });
      return { step, status, result: preview, error: verified ? undefined : preview.data.reason ?? preview.status };
    }
    if (!confirmed) {
      return { step, status: 'needs_confirmation', error: 'confirmation_required' };
    }
    const confirmedReflow = await confirmTrainingSessionReflow({
      userId: input.userId,
      sessionId,
      proposedStartAt: typeof args.proposedStartAt === 'string' ? args.proposedStartAt : typeof args.startDateTime === 'string' ? args.startDateTime : null,
      proposedEndAt: typeof args.proposedEndAt === 'string' ? args.proposedEndAt : typeof args.endDateTime === 'string' ? args.endDateTime : null,
      requestedCalendarSource: source,
    });
    const verified = confirmedReflow.status === 'confirmed' && confirmedReflow.data.verified === true;
    const status: ChatActionRunStatus = verified ? 'verified_success' : confirmedReflow.status === 'partial_failure' ? 'partial_success' : 'blocked';
    if (claim) updateChatActionRun(claim.row.id, status, {
      result: confirmedReflow,
      providerObjectId: 'data' in confirmedReflow && 'eventId' in confirmedReflow.data ? confirmedReflow.data.eventId ?? String(sessionId) : String(sessionId),
      verification: { verified, expected: { sessionId } },
    });
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
  const claim = claimActionRunForStep(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim) updateChatActionRun(claim.row.id, 'executing');
  try {
    if (step.action === 'notification_update_preference') {
      const patch = typeof args.preference === 'object' && args.preference ? args.preference as Record<string, unknown> : {};
      if (Object.keys(patch).length === 0) return { step, status: 'blocked', error: 'notification_preference_patch_required' };
      const profile = updateNotificationProfile(input.userId, input.tenantId, patch as any);
      const readBack = getOrCreateNotificationProfile(input.userId, input.tenantId);
      const verified = JSON.stringify(profile) === JSON.stringify(readBack);
      const result = { profile: readBack, verified };
      const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
      if (claim) updateChatActionRun(claim.row.id, status, { result, verification: { verified } });
      return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
    }
    const created = await createNotificationIntent({
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
    });
    const verified = created.intent?.intentId != null;
    const result = { intentId: created.intent.intentId, notificationId: created.item?.itemId ?? null, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (claim) updateChatActionRun(claim.row.id, status, { result, providerObjectId: created.intent.intentId, verification: { verified } });
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
  const claim = claimActionRunForStep(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  if (claim) updateChatActionRun(claim.row.id, 'executing');
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
      result = await performDecisionAction(decisionId, choice, input.userId, input.tenantId, {
        idempotencyKey: step.idempotencyKey,
        payload: typeof args.payload === 'object' && args.payload ? args.payload as Record<string, unknown> : {},
      });
    } else {
      result = getDecisionItem(decisionId, input.userId, input.tenantId);
    }
    const readBack = getDecisionItem(decisionId, input.userId, input.tenantId);
    const verified = Boolean(readBack);
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    const payload = { result, item: readBack, verified };
    if (claim) updateChatActionRun(claim.row.id, status, { result: payload, providerObjectId: decisionId, verification: { verified } });
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
      actionStatus: status,
      actionPlanner: plan.planner,
      involvedSkills: [...new Set(plan.steps.map((step) => step.skill))],
      // Developer trace is persisted server-side through action runs/logs; normal UI gets only this safe summary.
    },
    timestamp: new Date().toISOString(),
  };
}

function successCopy(input: ChatPlannerInput, results: Array<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown }>): string {
  const first = results[0];
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
  if (first?.step.action?.startsWith('notification_')) {
    return input.locale?.startsWith('pt') ? 'Feito — atualizei e verifiquei a área de notificações.' : 'Done — I updated and verified Notifications.';
  }
  if (first?.step.action?.startsWith('decision_')) {
    return input.locale?.startsWith('pt') ? 'Feito — atualizei a decisão e verifiquei o estado.' : 'Done — I updated the decision and verified its state.';
  }
  return input.locale?.startsWith('pt') ? 'Feito — concluí e verifiquei a ação.' : 'Done — I completed and verified the action.';
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

function actionToStepType(action: ChatActionName): ChatPlanStepType {
  return action;
}

function normalizeProvider(value: unknown): ChatProvider | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'google_calendar' || value === 'outlook_calendar' || value === 'gmail' || value === 'outlook_mail' || value === 'nexus' || value === 'stripe' || value === 'telegram' || value === 'none') {
    return value;
  }
  return undefined;
}

function pickExpectedFields(args: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const expected: Record<string, unknown> = {};
  for (const field of fields) {
    if (args[field] != null && args[field] !== '') expected[field] = args[field];
  }
  return expected;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.4;
  return Math.max(0, Math.min(1, value));
}

function stepRequiresConfirmation(step: ChatPlanStep): boolean {
  const definition = findChatActionDefinition(step.skill, step.action);
  return ['external_side_effect', 'destructive', 'financial', 'admin_security'].includes(step.risk)
    || definition?.confirmationPolicy === 'confirm'
    || definition?.confirmationPolicy === 'strong_confirm';
}

function inferContentPlatform(folded: string): string {
  if (/\btiktok\b/.test(folded)) return 'tiktok';
  if (/\b(reels?|instagram)\b/.test(folded)) return 'instagram_reel';
  if (/\b(shorts?|youtube shorts?)\b/.test(folded)) return 'youtube_shorts';
  if (/\byoutube\b/.test(folded)) return 'youtube';
  if (/\b(carousel|carrossel)\b/.test(folded)) return 'carousel';
  if (/\bblog\b/.test(folded)) return 'blog';
  if (/\bnewsletter\b/.test(folded)) return 'newsletter';
  return 'generic';
}

function inferProviderName(folded: string): string | null {
  if (/\b(google|gmail)\b/.test(folded)) return 'google';
  if (/\b(outlook|microsoft)\b/.test(folded)) return 'outlook';
  if (/\bgarmin\b/.test(folded)) return 'garmin';
  if (/\b(apple health|healthkit|saude|saúde)\b/.test(folded)) return 'apple_health';
  if (/\bstripe\b/.test(folded)) return 'stripe';
  return null;
}

function extractTopic(text: string): string | null {
  const patterns = [
    /\b(?:sobre|about|on|para|for|de)\s+(.+)$/i,
    /\b(?:chamad[oa]|called|named|titulo|título)\s+["“]?(.+?)["”]?$/i,
    /:\s*(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const topic = match?.[1]?.trim().replace(/[.?!]+$/g, '');
    if (topic && topic.length >= 3) return topic;
  }
  return null;
}
