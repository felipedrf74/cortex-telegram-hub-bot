// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDecisionSummary, type DecisionApiItem, type DecisionSummary } from '../../decision-center';
import {
  buildChatCoreV2ReadContextPack,
  buildChatCoreV2ReadModelResult,
  isReadModelFreshEnough,
} from '../read-models';
import {
  buildChatCoreV2MessageResponse,
  normalizeChatCoreV2Locale,
} from '../response-contracts';
import {
  DECISION_CENTER_SUMMARY_CAPABILITY,
  MAX_VISIBLE_DECISIONS,
  hashStable,
} from './common';
import { joinParts, plural, type ChatCoreV2NormalizedLocale } from './copy';
import type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2DecisionCenterSummaryData,
  ChatCoreV2DeterministicReadRouteResult,
} from './types';
import type { ChatCoreV2ShadowRouteGuess } from '../shadow-route-classifier';

export function buildDecisionCenterSummaryRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2DeterministicReadRouteResult | null {
  const now = input.now ?? new Date();
  const summary = getDecisionSummary(input.userId, input.tenantId, MAX_VISIBLE_DECISIONS);
  const data = summarizeDecisionCenter(summary);
  const readModel = buildChatCoreV2ReadModelResult<ChatCoreV2DecisionCenterSummaryData>({
    capabilityId: DECISION_CENTER_SUMMARY_CAPABILITY,
    domain: 'decision_center',
    data,
    sourceEntityIds: data.topItems.map((item) => item.entityId),
    sourceVersions: sourceVersionsForDecisions(summary.previewItems),
    generatedAt: now.toISOString(),
    maxSourceAgeSeconds: 60,
    sensitivity: 'personal',
    summary: buildDecisionCenterSummaryText(data, input.locale),
    locale: normalizeChatCoreV2Locale(input.locale),
    now,
  });
  if (!isReadModelFreshEnough(readModel)) return null;

  const contextPack = buildChatCoreV2ReadContextPack([readModel], { generatedAt: now.toISOString() });
  const response = buildChatCoreV2MessageResponse({
    text: readModel.summary ?? buildDecisionCenterSummaryText(data, input.locale),
    locale: input.locale,
    reasonCodes: ['deterministic_read', DECISION_CENTER_SUMMARY_CAPABILITY],
  });

  return {
    capabilityId: DECISION_CENTER_SUMMARY_CAPABILITY,
    routeGuess,
    readModel,
    contextPack,
    response,
  };
}

function summarizeDecisionCenter(summary: DecisionSummary): ChatCoreV2DecisionCenterSummaryData {
  return {
    openCount: summary.openCount,
    urgentCount: summary.urgentCount,
    todayCount: summary.todayCount,
    handledTodayCount: summary.handledTodayCount,
    badgeCount: summary.badgeCount,
    ctaLabel: summary.ctaLabel,
    topDecisionTitle: summary.topDecisionTitle,
    topDecisionWhy: summary.topDecisionWhy,
    topSuggestionTitle: summary.topSuggestion?.title ?? null,
    topItems: summary.previewItems.slice(0, MAX_VISIBLE_DECISIONS).map((item) => ({
      entityId: decisionEntityId(item),
      title: item.safePreviewTitle || item.title,
      sourceSkill: item.sourceSkill,
      urgency: item.urgency,
      status: item.status,
      actionLabel: item.explanation?.actionLabels?.primary ?? item.primaryActionLabel ?? item.recommendedActionLabel,
      why: item.explanation?.whyItMatters ?? item.whySummary ?? item.analysis?.whyNow ?? null,
    })),
  };
}

function buildDecisionCenterSummaryText(
  data: ChatCoreV2DecisionCenterSummaryData,
  locale: string | null | undefined,
): string {
  const normalizedLocale = normalizeChatCoreV2Locale(locale);
  if (data.openCount === 0) {
    if (normalizedLocale === 'pt-BR') return 'O Decision Center está sem pendências agora.';
    if (normalizedLocale === 'pt-PT') return 'O Decision Center não tem pendências neste momento.';
    if (normalizedLocale === 'es') return 'El Decision Center está al día ahora.';
    return 'Decision Center is clear right now.';
  }

  const header = buildDecisionCenterSummaryHeader(data, normalizedLocale);
  if (data.topItems.length === 0) return header;
  const itemLines = data.topItems.map((item) => {
    const action = item.actionLabel ? decisionActionSuffix(item.actionLabel, normalizedLocale) : '';
    return `- ${item.title}${decisionUrgencySuffix(item.urgency, normalizedLocale)}${action}`;
  });
  return `${header}\n\n${decisionListLabel(normalizedLocale)}\n${itemLines.join('\n')}`;
}

function buildDecisionCenterSummaryHeader(
  data: ChatCoreV2DecisionCenterSummaryData,
  locale: ChatCoreV2NormalizedLocale,
): string {
  const parts: string[] = [];
  if (data.urgentCount > 0) parts.push(decisionCountPhrase(data.urgentCount, locale, 'urgent'));
  if (data.todayCount > 0) parts.push(decisionCountPhrase(data.todayCount, locale, 'today'));
  if (data.handledTodayCount > 0) parts.push(decisionCountPhrase(data.handledTodayCount, locale, 'handled'));
  const detail = parts.length > 0 ? ` ${joinParts(parts, locale)}` : '';
  if (locale === 'pt-BR') return `O Decision Center tem ${data.openCount} ${plural(data.openCount, 'decisão aberta', 'decisões abertas')}.${detail}`;
  if (locale === 'pt-PT') return `O Decision Center tem ${data.openCount} ${plural(data.openCount, 'decisão aberta', 'decisões abertas')}.${detail}`;
  if (locale === 'es') return `Decision Center tiene ${data.openCount} ${plural(data.openCount, 'decisión abierta', 'decisiones abiertas')}.${detail}`;
  return `Decision Center has ${data.openCount} open ${data.openCount === 1 ? 'decision' : 'decisions'}.${detail}`;
}

function decisionCountPhrase(
  count: number,
  locale: ChatCoreV2NormalizedLocale,
  kind: 'urgent' | 'today' | 'handled',
): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') {
    if (kind === 'urgent') return `${count} ${plural(count, 'urgente', 'urgentes')}`;
    if (kind === 'today') return `${count} ${plural(count, 'para hoje', 'para hoje')}`;
    return `${count} ${plural(count, 'tratada hoje', 'tratadas hoje')}`;
  }
  if (locale === 'es') {
    if (kind === 'urgent') return `${count} ${plural(count, 'urgente', 'urgentes')}`;
    if (kind === 'today') return `${count} ${plural(count, 'para hoy', 'para hoy')}`;
    return `${count} ${plural(count, 'gestionada hoy', 'gestionadas hoy')}`;
  }
  if (kind === 'urgent') return `${count} urgent`;
  if (kind === 'today') return `${count} for today`;
  return `${count} handled today`;
}

function decisionListLabel(locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR') return 'Principais decisões:';
  if (locale === 'pt-PT') return 'Decisões principais:';
  if (locale === 'es') return 'Decisiones principales:';
  return 'Top decisions:';
}

function decisionUrgencySuffix(urgency: string, locale: ChatCoreV2NormalizedLocale): string {
  if (urgency === 'urgent') {
    if (locale === 'pt-BR' || locale === 'pt-PT') return ' (urgente)';
    if (locale === 'es') return ' (urgente)';
    return ' (urgent)';
  }
  if (urgency === 'today') {
    if (locale === 'pt-BR' || locale === 'pt-PT') return ' (hoje)';
    if (locale === 'es') return ' (hoy)';
    return ' (today)';
  }
  return '';
}

function decisionActionSuffix(actionLabel: string, locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') return ` - precisa de: ${actionLabel}`;
  if (locale === 'es') return ` - necesita: ${actionLabel}`;
  return ` - needs: ${actionLabel}`;
}

function sourceVersionsForDecisions(items: DecisionApiItem[]): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const item of items) {
    versions[decisionEntityId(item)] = hashStable({
      status: item.status,
      urgency: item.urgency,
      title: item.safePreviewTitle || item.title,
      actionLabel: item.explanation?.actionLabels?.primary ?? item.primaryActionLabel ?? item.recommendedActionLabel,
      updatedAt: item.updatedAt,
      snoozedUntil: item.snoozedUntil,
    });
  }
  return versions;
}

function decisionEntityId(item: DecisionApiItem): string {
  return `decision:${item.decisionId}`;
}
