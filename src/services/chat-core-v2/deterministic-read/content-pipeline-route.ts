// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  getContentDeskItems,
  getRankedContentSignals,
  type ContentDeskItem,
  type ContentSignalDigest,
} from '../../content-intelligence';
import { getTopics, type ContentTopic } from '../../content-scheduler';
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
  CONTENT_PIPELINE_SUMMARY_CAPABILITY,
  MAX_VISIBLE_CONTENT_ITEMS,
  hashStable,
} from './common';
import { joinParts, plural, type ChatCoreV2NormalizedLocale } from './copy';
import type { ChatCoreV2ShadowRouteGuess } from '../shadow-route-classifier';
import type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2ContentPipelineSummaryData,
  ChatCoreV2ContentPipelineSummaryItem,
  ChatCoreV2DeterministicReadRouteResult,
} from './types';

const CONTENT_TOPIC_SCAN_LIMIT = 20;
const CONTENT_DESK_SCAN_LIMIT = 5;
const CONTENT_SIGNAL_SCAN_LIMIT = 5;

export function buildContentPipelineSummaryRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2DeterministicReadRouteResult | null {
  const now = input.now ?? new Date();
  const topics = getTopics(input.userId, { includeTerminal: false, limit: CONTENT_TOPIC_SCAN_LIMIT });
  const deskItems = getContentDeskItems(input.userId, CONTENT_DESK_SCAN_LIMIT);
  const signals = getRankedContentSignals(input.userId, CONTENT_SIGNAL_SCAN_LIMIT);
  const data = buildContentPipelineSummaryData(topics, deskItems, signals);
  const sourceEntityIds = data.topItems.map((item) => item.entityId);
  const readModel = buildChatCoreV2ReadModelResult<ChatCoreV2ContentPipelineSummaryData>({
    capabilityId: CONTENT_PIPELINE_SUMMARY_CAPABILITY,
    domain: 'content',
    data,
    sourceEntityIds,
    sourceVersions: sourceVersionsForContent(topics, deskItems, signals),
    generatedAt: now.toISOString(),
    maxSourceAgeSeconds: 60,
    sensitivity: 'personal',
    summary: buildContentPipelineSummaryText(data, input.locale),
    locale: normalizeChatCoreV2Locale(input.locale),
    now,
  });
  if (!isReadModelFreshEnough(readModel)) return null;

  const contextPack = buildChatCoreV2ReadContextPack([readModel], { generatedAt: now.toISOString() });
  const response = buildChatCoreV2MessageResponse({
    text: readModel.summary ?? buildContentPipelineSummaryText(data, input.locale),
    locale: input.locale,
    reasonCodes: ['deterministic_read', CONTENT_PIPELINE_SUMMARY_CAPABILITY],
  });

  return {
    capabilityId: CONTENT_PIPELINE_SUMMARY_CAPABILITY,
    routeGuess,
    readModel,
    contextPack,
    response,
  };
}

function buildContentPipelineSummaryData(
  topics: ContentTopic[],
  deskItems: ContentDeskItem[],
  signals: ContentSignalDigest[],
): ChatCoreV2ContentPipelineSummaryData {
  const visibleTopics = topics.slice(0, MAX_VISIBLE_CONTENT_ITEMS).map(topicToSummaryItem);
  const remainingSlots = Math.max(0, MAX_VISIBLE_CONTENT_ITEMS - visibleTopics.length);
  const visibleDeskItems = deskItems.slice(0, remainingSlots).map(deskItemToSummaryItem);
  const remainingSignalSlots = Math.max(0, MAX_VISIBLE_CONTENT_ITEMS - visibleTopics.length - visibleDeskItems.length);
  const visibleSignals = signals.slice(0, remainingSignalSlots).map(signalToSummaryItem);

  return {
    topicCount: topics.length,
    plannedCount: countTopics(topics, 'planned'),
    draftingCount: countTopics(topics, 'drafting'),
    readyCount: countTopics(topics, 'ready'),
    publishedCount: countTopics(topics, 'published'),
    scheduledCount: topics.filter((topic) => Boolean(topic.scheduled_date)).length,
    deskReadyCount: deskItems.length,
    urgentSignalCount: signals.filter((signal) => signal.priority === 'urgent').length,
    topItems: [...visibleTopics, ...visibleDeskItems, ...visibleSignals],
  };
}

function topicToSummaryItem(topic: ContentTopic): ChatCoreV2ContentPipelineSummaryItem {
  return {
    entityId: contentTopicEntityId(topic.id),
    title: topic.title,
    kind: 'topic',
    status: normalizeStatus(topic.status),
    scheduledDate: topic.scheduled_date ?? null,
    priority: null,
    createdAt: topic.created_at ?? null,
  };
}

function deskItemToSummaryItem(item: ContentDeskItem): ChatCoreV2ContentPipelineSummaryItem {
  return {
    entityId: contentDeskEntityId(item.id),
    title: item.title,
    kind: 'desk_item',
    status: normalizeStatus(item.type),
    scheduledDate: null,
    priority: null,
    createdAt: item.createdAt ?? null,
  };
}

function signalToSummaryItem(signal: ContentSignalDigest): ChatCoreV2ContentPipelineSummaryItem {
  return {
    entityId: contentSignalEntityId(signal),
    title: signal.title,
    kind: 'signal',
    status: normalizeStatus(signal.type),
    scheduledDate: null,
    priority: signal.priority,
    createdAt: null,
  };
}

function buildContentPipelineSummaryText(
  data: ChatCoreV2ContentPipelineSummaryData,
  locale: string | null | undefined,
): string {
  const normalizedLocale = normalizeChatCoreV2Locale(locale);
  if (data.topicCount === 0 && data.deskReadyCount === 0 && data.urgentSignalCount === 0) {
    if (normalizedLocale === 'pt-BR') return 'Seu pipeline de conteúdo ainda não tem itens acompanhados.';
    if (normalizedLocale === 'pt-PT') return 'O teu pipeline de conteúdo ainda não tem itens acompanhados.';
    if (normalizedLocale === 'es') return 'Tu pipeline de contenido aún no tiene elementos en seguimiento.';
    return 'Your content pipeline has no tracked items yet.';
  }

  const header = buildContentPipelineHeader(data, normalizedLocale);
  if (data.topItems.length === 0) return header;
  const itemLines = data.topItems.map((item) => `- ${item.title}${contentItemSuffix(item, normalizedLocale)}`);
  return `${header}\n\n${contentListLabel(normalizedLocale)}\n${itemLines.join('\n')}`;
}

function buildContentPipelineHeader(
  data: ChatCoreV2ContentPipelineSummaryData,
  locale: ChatCoreV2NormalizedLocale,
): string {
  const parts: string[] = [];
  if (data.readyCount > 0) parts.push(countPhrase(data.readyCount, locale, 'ready'));
  if (data.draftingCount > 0) parts.push(countPhrase(data.draftingCount, locale, 'drafting'));
  if (data.scheduledCount > 0) parts.push(countPhrase(data.scheduledCount, locale, 'scheduled'));
  if (data.deskReadyCount > 0) parts.push(countPhrase(data.deskReadyCount, locale, 'desk'));
  if (data.urgentSignalCount > 0) parts.push(countPhrase(data.urgentSignalCount, locale, 'urgent_signal'));

  const detail = parts.length > 0 ? ` ${joinParts(parts, locale)}.` : '';
  if (locale === 'pt-BR') return `Pipeline de conteúdo: ${data.topicCount} ${plural(data.topicCount, 'tópico acompanhado', 'tópicos acompanhados')}.${detail}`;
  if (locale === 'pt-PT') return `Pipeline de conteúdo: ${data.topicCount} ${plural(data.topicCount, 'tópico acompanhado', 'tópicos acompanhados')}.${detail}`;
  if (locale === 'es') return `Pipeline de contenido: ${data.topicCount} ${plural(data.topicCount, 'tema en seguimiento', 'temas en seguimiento')}.${detail}`;
  return `Content pipeline: ${data.topicCount} tracked ${plural(data.topicCount, 'topic', 'topics')}.${detail}`;
}

function countPhrase(
  count: number,
  locale: ChatCoreV2NormalizedLocale,
  kind: 'ready' | 'drafting' | 'scheduled' | 'desk' | 'urgent_signal',
): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') {
    if (kind === 'ready') return `${count} ${plural(count, 'pronto', 'prontos')}`;
    if (kind === 'drafting') return `${count} em rascunho`;
    if (kind === 'scheduled') return `${count} ${plural(count, 'agendado', 'agendados')}`;
    if (kind === 'desk') return `${count} ${plural(count, 'item pronto na mesa', 'itens prontos na mesa')}`;
    return `${count} ${plural(count, 'sinal urgente', 'sinais urgentes')}`;
  }
  if (locale === 'es') {
    if (kind === 'ready') return `${count} ${plural(count, 'listo', 'listos')}`;
    if (kind === 'drafting') return `${count} en borrador`;
    if (kind === 'scheduled') return `${count} ${plural(count, 'programado', 'programados')}`;
    if (kind === 'desk') return `${count} ${plural(count, 'elemento listo en la mesa', 'elementos listos en la mesa')}`;
    return `${count} ${plural(count, 'señal urgente', 'señales urgentes')}`;
  }
  if (kind === 'ready') return `${count} ready`;
  if (kind === 'drafting') return `${count} drafting`;
  if (kind === 'scheduled') return `${count} scheduled`;
  if (kind === 'desk') return `${count} desk-ready ${plural(count, 'item', 'items')}`;
  return `${count} urgent ${plural(count, 'signal', 'signals')}`;
}

function contentListLabel(locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR') return 'Principais itens:';
  if (locale === 'pt-PT') return 'Itens principais:';
  if (locale === 'es') return 'Elementos principales:';
  return 'Top items:';
}

function contentItemSuffix(
  item: ChatCoreV2ContentPipelineSummaryItem,
  locale: ChatCoreV2NormalizedLocale,
): string {
  const parts = [
    kindLabel(item.kind, locale),
    statusLabel(item.status, locale),
    item.scheduledDate ? scheduledDatePhrase(item.scheduledDate, locale) : null,
    item.priority === 'urgent' ? urgentLabel(locale) : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function kindLabel(kind: ChatCoreV2ContentPipelineSummaryItem['kind'], locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') {
    if (kind === 'topic') return 'tópico';
    if (kind === 'desk_item') return 'mesa';
    return 'sinal';
  }
  if (locale === 'es') {
    if (kind === 'topic') return 'tema';
    if (kind === 'desk_item') return 'mesa';
    return 'señal';
  }
  if (kind === 'topic') return 'topic';
  if (kind === 'desk_item') return 'desk';
  return 'signal';
}

function statusLabel(status: string, locale: ChatCoreV2NormalizedLocale): string {
  const normalized = normalizeStatus(status);
  if (locale === 'pt-BR' || locale === 'pt-PT') {
    const labels: Record<string, string> = {
      planned: 'planeado',
      drafting: 'em rascunho',
      ready: 'pronto',
      published: 'publicado',
      script_ready: 'script pronto',
      topic_candidates_ready: 'ideias prontas',
      weekly_package_ready: 'pacote semanal pronto',
      reaction_opportunity: 'janela de reação',
      trending_spike: 'tendência',
      pipeline_bottleneck: 'bloqueio',
    };
    return labels[normalized] ?? normalized.replace(/_/g, ' ');
  }
  if (locale === 'es') {
    const labels: Record<string, string> = {
      planned: 'planificado',
      drafting: 'en borrador',
      ready: 'listo',
      published: 'publicado',
      script_ready: 'guion listo',
      topic_candidates_ready: 'ideas listas',
      weekly_package_ready: 'paquete semanal listo',
      reaction_opportunity: 'ventana de reacción',
      trending_spike: 'tendencia',
      pipeline_bottleneck: 'bloqueo',
    };
    return labels[normalized] ?? normalized.replace(/_/g, ' ');
  }
  return normalized.replace(/_/g, ' ');
}

function scheduledDatePhrase(date: string, locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') return `agendado para ${date}`;
  if (locale === 'es') return `programado para ${date}`;
  return `scheduled ${date}`;
}

function urgentLabel(locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') return 'urgente';
  if (locale === 'es') return 'urgente';
  return 'urgent';
}

function sourceVersionsForContent(
  topics: ContentTopic[],
  deskItems: ContentDeskItem[],
  signals: ContentSignalDigest[],
): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const topic of topics.slice(0, MAX_VISIBLE_CONTENT_ITEMS)) {
    versions[contentTopicEntityId(topic.id)] = hashStable({
      title: topic.title,
      status: topic.status,
      scheduledDate: topic.scheduled_date ?? null,
      createdAt: topic.created_at,
      updatedAt: topic.updated_at,
    });
  }
  for (const item of deskItems.slice(0, MAX_VISIBLE_CONTENT_ITEMS)) {
    versions[contentDeskEntityId(item.id)] = hashStable({
      title: item.title,
      type: item.type,
      createdAt: item.createdAt,
    });
  }
  for (const signal of signals.slice(0, MAX_VISIBLE_CONTENT_ITEMS)) {
    versions[contentSignalEntityId(signal)] = hashStable({
      type: signal.type,
      title: signal.title,
      priority: signal.priority,
      relevanceScore: signal.relevanceScore,
      confidence: signal.confidence,
    });
  }
  return versions;
}

function countTopics(topics: ContentTopic[], status: ContentTopic['status']): number {
  return topics.filter((topic) => normalizeStatus(topic.status) === status).length;
}

function contentTopicEntityId(topicId: number): string {
  return `content_topic:${topicId}`;
}

function contentDeskEntityId(itemId: number): string {
  return `content_desk:${itemId}`;
}

function contentSignalEntityId(signal: ContentSignalDigest): string {
  return `content_signal:${hashStable({ type: signal.type, title: signal.title }).slice(0, 12)}`;
}

function normalizeStatus(value: unknown): string {
  return String(value || 'unknown').trim().toLowerCase();
}
