// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { type RuntimeFlagScope } from '../runtime-flags';
import { detectChatCoreV2WriteIntent } from './action-gateway';
import {
  isChatCoreV2MasterKillSwitchOff,
  resolveChatCoreV2ActivationConfig,
  resolveChatCoreV2AllowedDomainsForTenant,
} from './activation-flags';
import { classifyShadowRoute, type ChatCoreV2ShadowRouteGuess } from './shadow-route-classifier';
import { isChatCoreV2CapabilityEnabled } from './capability-registry';
import { buildChatCoreV2ReadContextPack } from './read-models';
import { buildChatCoreV2MessageResponse, normalizeChatCoreV2Locale } from './response-contracts';
import {
  CONNECTIONS_STATUS_CAPABILITY,
  CONTENT_PIPELINE_SUMMARY_CAPABILITY,
  COOKING_MEAL_PLAN_SUMMARY_CAPABILITY,
  DECISION_CENTER_SUMMARY_CAPABILITY,
  FINANCE_SUMMARY_CAPABILITY,
  NOTIFICATIONS_SUMMARY_CAPABILITY,
  SECRETARY_AGENDA_SUMMARY_CAPABILITY,
  TASKS_TODAY_SUMMARY_CAPABILITY,
  TRAINING_SESSION_EXPLAIN_CAPABILITY,
} from './deterministic-read/common';
import { buildAgendaSummaryRoute } from './deterministic-read/agenda-summary-route';
import { buildConnectionsStatusRoute } from './deterministic-read/connection-status-route';
import { buildContentPipelineSummaryRoute } from './deterministic-read/content-pipeline-route';
import { buildCookingMealPlanSummaryRoute } from './deterministic-read/cooking-meal-plan-route';
import { buildDecisionCenterSummaryRoute } from './deterministic-read/decision-center-summary-route';
import { buildFinanceSummaryRoute } from './deterministic-read/finance-summary-route';
import { buildNotificationsSummaryRoute } from './deterministic-read/notification-summary-route';
import { buildTaskSummaryRoute } from './deterministic-read/task-summary-route';
import { buildTrainingSessionExplainRoute } from './deterministic-read/training-session-route';
import type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2DeterministicReadBuilder,
  ChatCoreV2DeterministicReadCapabilityId,
  ChatCoreV2DeterministicReadRouteResult,
} from './deterministic-read/types';

export type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2AgendaSummaryData,
  ChatCoreV2AgendaSummaryItem,
  ChatCoreV2ConnectionStatusData,
  ChatCoreV2ConnectionStatusItem,
  ChatCoreV2ContentPipelineSummaryData,
  ChatCoreV2ContentPipelineSummaryItem,
  ChatCoreV2CookingMealPlanSummaryData,
  ChatCoreV2CookingMealSummaryItem,
  ChatCoreV2CookingShoppingSummaryItem,
  ChatCoreV2DecisionCenterSummaryData,
  ChatCoreV2DecisionCenterSummaryItem,
  ChatCoreV2DeterministicReadCapabilityId,
  ChatCoreV2DeterministicReadData,
  ChatCoreV2DeterministicReadRouteResult,
  ChatCoreV2FinanceSummaryData,
  ChatCoreV2NotificationSummaryData,
  ChatCoreV2NotificationSummaryItem,
  ChatCoreV2TaskSummaryData,
  ChatCoreV2TaskSummaryItem,
  ChatCoreV2TrainingSessionExplainData,
  ChatCoreV2TrainingSessionSummaryItem,
} from './deterministic-read/types';

type ChatCoreV2CapabilityFlagInput = Parameters<typeof isChatCoreV2CapabilityEnabled>[1];

const DETERMINISTIC_READ_BUILDERS: Record<ChatCoreV2DeterministicReadCapabilityId, ChatCoreV2DeterministicReadBuilder> = {
  [SECRETARY_AGENDA_SUMMARY_CAPABILITY]: buildAgendaSummaryRoute,
  [TASKS_TODAY_SUMMARY_CAPABILITY]: buildTaskSummaryRoute,
  [DECISION_CENTER_SUMMARY_CAPABILITY]: buildDecisionCenterSummaryRoute,
  [NOTIFICATIONS_SUMMARY_CAPABILITY]: buildNotificationsSummaryRoute,
  [CONNECTIONS_STATUS_CAPABILITY]: buildConnectionsStatusRoute,
  [FINANCE_SUMMARY_CAPABILITY]: buildFinanceSummaryRoute,
  [TRAINING_SESSION_EXPLAIN_CAPABILITY]: buildTrainingSessionExplainRoute,
  [CONTENT_PIPELINE_SUMMARY_CAPABILITY]: buildContentPipelineSummaryRoute,
  [COOKING_MEAL_PLAN_SUMMARY_CAPABILITY]: buildCookingMealPlanSummaryRoute,
};

export function tryBuildChatCoreV2DeterministicReadRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
): ChatCoreV2DeterministicReadRouteResult | null {
  const text = input.normalizedText.trim();
  if (!text) return null;
  if (detectChatCoreV2WriteIntent(text).mayMutate) return null;

  const routeGuess = classifyShadowRoute(text);
  if (!shouldServeDeterministicReadForText(text, routeGuess)) return null;
  const capabilityIds = deterministicReadCapabilitiesForRouteGuess(routeGuess);
  if (capabilityIds.length === 0) return null;

  const env = input.env ?? process.env;
  if (isChatCoreV2MasterKillSwitchOff(env, String(input.tenantId))) return null;
  const hasExplicitActivationMode = hasExplicitChatCoreV2ActivationMode(env);
  if (isDeterministicReadExplicitlyDisabled(env)) return null;
  if (hasExplicitActivationMode) {
    const activation = resolveChatCoreV2ActivationConfig(env);
    if (activation.mode !== 'canary' && activation.mode !== 'on') return null;
    if (!activation.allowDeterministicReads) return null;
    if (!activation.allowedSurfaces.includes(input.surface ?? 'ios')) return null;
    const allowedDomains = resolveChatCoreV2AllowedDomainsForTenant(env, input.tenantId);
    if (!routeGuess.domains.every((domain) => allowedDomains.has(domain))) return null;
  }

  const scope: RuntimeFlagScope = { userId: input.userId, tenantId: input.tenantId };
  const flagInput: ChatCoreV2CapabilityFlagInput = {
    env,
    scope,
  };
  const enabledCapabilityIds = hasExplicitActivationMode
    ? capabilityIds
    : capabilityIds.filter((capabilityId) => isChatCoreV2CapabilityEnabled(capabilityId, flagInput));
  if (enabledCapabilityIds.length === 0) return null;

  const results = enabledCapabilityIds
    .map((capabilityId) => DETERMINISTIC_READ_BUILDERS[capabilityId](input, routeGuess))
    .filter((result): result is ChatCoreV2DeterministicReadRouteResult => result != null);
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  const readModels = results.map((result) => result.readModel);
  const contextPack = buildChatCoreV2ReadContextPack(readModels, {
    generatedAt: (input.now ?? new Date()).toISOString(),
  });
  const combinedCapabilityIds = results.map((result) => result.capabilityId);
  const response = buildChatCoreV2MessageResponse({
    text: buildMultiDomainReadText(results, input.locale),
    locale: input.locale,
    reasonCodes: ['deterministic_read', 'multi_domain_read', ...combinedCapabilityIds],
  });

  return {
    capabilityId: results[0].capabilityId,
    capabilityIds: combinedCapabilityIds,
    routeGuess,
    readModel: results[0].readModel,
    readModels,
    contextPack,
    response,
  };
}

function shouldServeDeterministicReadForText(
  text: string,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): boolean {
  const normalized = text.toLowerCase();
  if (isExplicitExternalResearchRequest(normalized)) return false;
  if (routeGuess.domains.includes('training') && isTrainingHealthAdviceQuestion(normalized)) return false;
  if (!routeGuess.domains.includes('cooking') && !routeGuess.domains.includes('content')) return true;
  if (
    routeGuess.domains.includes('cooking')
    && (
      /\b(meal\s+plan|shopping\s+list|grocery|groceries|pantry|planned\s+meals?|logged|registered)\b/i.test(normalized)
      || /\b(?:what\s+)?meals?\s+(?:do\s+i\s+have|have\s+i\s+(?:got|planned)|are\s+(?:planned|logged|registered)|this\s+week)\b/i.test(normalized)
    )
  ) {
    return true;
  }
  if (
    routeGuess.domains.includes('cooking')
    && /\b(plano\s+de\s+refei|lista\s+de\s+compras|compras|despensa|refei(?:cao|ção|coes|ções)\s+planead|registad|registrad|que\s+refei(?:cao|ção|coes|ções)\s+tenho\s+(?:planead|registad|registrad)|refei(?:cao|ção|coes|ções)\s+(?:tenho|estao|estão).*(?:semana|hoje))\b/i.test(normalized)
  ) {
    return true;
  }
  if (
    routeGuess.domains.includes('content')
    && /\b(content\s+desk|pipeline|ready|planned|drafting|published|scheduled|already\s+ready|on\s+my\s+desk|pillars?|filming|film|publish|priority|work\s+on|performance|performing|performed|learnings?|hooks?|formats?|winning|working|tracking)\b/i.test(normalized)
  ) {
    return true;
  }
  if (
    routeGuess.domains.includes('content')
    && /\b(mesa\s+de\s+conte[uú]do|pipeline|pront[oa]s?|planead[oa]s?|rascunh|publicar|publicad[oa]s?|agendad[oa]s?|prioridade|trabalhar\s+a\s+seguir|pilares?|filmar|filmagens?|performou|aprend(?:endo|er)|ganchos?|hooks?|formatos?|vencendo|funcionando)\b/i.test(normalized)
  ) {
    return true;
  }
  return routeGuess.domains.some((domain) => domain !== 'cooking' && domain !== 'content');
}

function isExplicitExternalResearchRequest(normalizedText: string): boolean {
  const hasResearchVerb = /\b(search|research|find|look\s+up|compare|pesquisa(?:r)?|procura(?:r)?|busca(?:r)?|investiga(?:r)?)\b/i.test(normalizedText);
  const hasExternalEvidenceSignal = /\b(recent|recentes|recientes|current|atuais|actuales|sources?|fontes|fuentes|scientific|cient[ií]ficas?|medical|m[eé]dicas?|p[uú]blicas?|public|official|oficiais|not[ií]cias|news|web|internet|2026)\b/i.test(normalizedText);
  return hasResearchVerb && hasExternalEvidenceSignal;
}

function isTrainingHealthAdviceQuestion(normalizedText: string): boolean {
  const hasHealthSignal = /\b(knee|joelho|rodilla|pain|dor|dolor|injury|injuries|les[aã]o|lesion|lesi[oó]n|hurt|hurts|sore|soreness|ache|aches|symptom|sintoma|ill|sick|doente|enfermo)\b/i.test(normalizedText);
  if (!hasHealthSignal) return false;
  return /\b(should|devo|deveria|posso|can\s+i|treinar|train|training|workout|exercise|exerc[ií]cio|entrenar|entrenamiento|run|correr)\b/i.test(normalizedText);
}

function hasExplicitChatCoreV2ActivationMode(env: NodeJS.ProcessEnv): boolean {
  return String(env.CHAT_CORE_V2_ORCHESTRATOR_MODE ?? '').trim().length > 0;
}

function isDeterministicReadExplicitlyDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = String(env.CHAT_CORE_V2_ALLOW_DETERMINISTIC_READS ?? '').trim().toLowerCase();
  return raw === 'false' || raw === '0' || raw === 'off' || raw === 'no';
}

function deterministicReadCapabilitiesForRouteGuess(
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2DeterministicReadCapabilityId[] {
  if (routeGuess.intent !== 'app_question') return [];
  const capabilityIds: ChatCoreV2DeterministicReadCapabilityId[] = [];
  for (const domain of routeGuess.domains) {
    const capabilityId = deterministicReadCapabilityForDomain(domain);
    if (capabilityId && routeGuess.capabilityIds.includes(capabilityId) && !capabilityIds.includes(capabilityId)) {
      capabilityIds.push(capabilityId);
    }
  }
  return capabilityIds;
}

function deterministicReadCapabilityForDomain(
  domain: ChatCoreV2ShadowRouteGuess['domains'][number],
): ChatCoreV2DeterministicReadCapabilityId | null {
  if (domain === 'tasks') return TASKS_TODAY_SUMMARY_CAPABILITY;
  if (domain === 'secretary') return SECRETARY_AGENDA_SUMMARY_CAPABILITY;
  if (domain === 'decision_center') return DECISION_CENTER_SUMMARY_CAPABILITY;
  if (domain === 'notifications') return NOTIFICATIONS_SUMMARY_CAPABILITY;
  if (domain === 'connections') return CONNECTIONS_STATUS_CAPABILITY;
  if (domain === 'finance') return FINANCE_SUMMARY_CAPABILITY;
  if (domain === 'training') return TRAINING_SESSION_EXPLAIN_CAPABILITY;
  if (domain === 'content') return CONTENT_PIPELINE_SUMMARY_CAPABILITY;
  if (domain === 'cooking') return COOKING_MEAL_PLAN_SUMMARY_CAPABILITY;
  return null;
}

function buildMultiDomainReadText(
  results: ChatCoreV2DeterministicReadRouteResult[],
  locale: string | null | undefined,
): string {
  return results
    .map((result) => `${domainReadHeading(result.readModel.domain, locale)}\n${result.response.text}`)
    .join('\n\n');
}

function domainReadHeading(
  domain: ChatCoreV2ShadowRouteGuess['domains'][number],
  locale: string | null | undefined,
): string {
  const normalizedLocale = normalizeChatCoreV2Locale(locale);
  if (normalizedLocale === 'pt-BR' || normalizedLocale === 'pt-PT') {
    if (domain === 'secretary') return 'Agenda';
    if (domain === 'tasks') return 'Tarefas';
    if (domain === 'training') return 'Treino';
    if (domain === 'content') return 'Conteudo';
    if (domain === 'cooking') return 'Cozinha';
    if (domain === 'finance') return 'Financas';
    if (domain === 'connections') return 'Ligacoes';
    if (domain === 'notifications') return 'Notificacoes';
    return 'Centro de decisoes';
  }
  if (normalizedLocale === 'es') {
    if (domain === 'secretary') return 'Agenda';
    if (domain === 'tasks') return 'Tareas';
    if (domain === 'training') return 'Entrenamiento';
    if (domain === 'content') return 'Contenido';
    if (domain === 'cooking') return 'Cocina';
    if (domain === 'finance') return 'Finanzas';
    if (domain === 'connections') return 'Conexiones';
    if (domain === 'notifications') return 'Notificaciones';
    return 'Centro de decisiones';
  }
  if (domain === 'secretary') return 'Agenda';
  if (domain === 'tasks') return 'Tasks';
  if (domain === 'training') return 'Training';
  if (domain === 'content') return 'Content';
  if (domain === 'cooking') return 'Cooking';
  if (domain === 'finance') return 'Finance';
  if (domain === 'connections') return 'Connections';
  if (domain === 'notifications') return 'Notifications';
  return 'Decision Center';
}
