// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  getActiveContentPillars,
  getContentDeskItems,
  getRankedContentSignals,
  type ContentDeskItem,
  type ContentPillarSummary,
  type ContentSignalDigest,
} from '../../content-intelligence';
import { getLearnedPatterns, getPerformanceSummary } from '../../content-learning-store';
import { getTopics, getUpcomingTopicCount, type ContentTopic } from '../../content-scheduler';
import { parseContentStateShortcut, type ContentStateShortcut } from '../../../api/routes/chat-shortcut-parsers';
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
  const signals = getRankedContentSignals(input.userId, CONTENT_SIGNAL_SCAN_LIMIT, input.tenantId);
  const shortcut = parseContentStateShortcut(input.normalizedText);
  const data = buildContentPipelineSummaryData(topics, deskItems, signals);
  const sourceEntityIds = data.topItems.map((item) => item.entityId);
  if (shortcut) sourceEntityIds.push(contentShortcutEntityId(shortcut));
  const summary = buildContentPipelineSummaryTextForRequest({
    shortcut,
    data,
    topics,
    deskItems,
    signals,
    userId: input.userId,
    locale: input.locale,
  });
  const readModel = buildChatCoreV2ReadModelResult<ChatCoreV2ContentPipelineSummaryData>({
    capabilityId: CONTENT_PIPELINE_SUMMARY_CAPABILITY,
    domain: 'content',
    data,
    sourceEntityIds,
    sourceVersions: sourceVersionsForContent(topics, deskItems, signals),
    generatedAt: now.toISOString(),
    maxSourceAgeSeconds: 60,
    sensitivity: 'personal',
    summary,
    locale: normalizeChatCoreV2Locale(input.locale),
    now,
  });
  if (!isReadModelFreshEnough(readModel)) return null;

  const contextPack = buildChatCoreV2ReadContextPack([readModel], { generatedAt: now.toISOString() });
  const response = buildChatCoreV2MessageResponse({
    text: readModel.summary ?? summary,
    locale: input.locale,
    reasonCodes: [
      'deterministic_read',
      CONTENT_PIPELINE_SUMMARY_CAPABILITY,
      ...(shortcut ? [`content_shortcut:${shortcut}`] : []),
    ],
  });

  return {
    capabilityId: CONTENT_PIPELINE_SUMMARY_CAPABILITY,
    routeGuess,
    readModel,
    contextPack,
    response,
  };
}

function buildContentPipelineSummaryTextForRequest(input: {
  shortcut: ContentStateShortcut | null;
  data: ChatCoreV2ContentPipelineSummaryData;
  topics: ContentTopic[];
  deskItems: ContentDeskItem[];
  signals: ContentSignalDigest[];
  userId: number;
  locale: string | null | undefined;
}): string {
  if (!input.shortcut) return buildContentPipelineSummaryText(input.data, input.locale);
  const normalizedLocale = normalizeChatCoreV2Locale(input.locale);

  if (input.shortcut === 'pillars') {
    return buildContentPillarsText(getActiveContentPillars(input.userId), normalizedLocale);
  }
  if (input.shortcut === 'performance') {
    return buildContentPerformanceText(input.userId, normalizedLocale);
  }
  if (input.shortcut === 'learning') {
    return buildContentLearningText(input.userId, normalizedLocale);
  }
  if (input.shortcut === 'filming') {
    return buildContentFilmingText(input.userId, normalizedLocale);
  }
  if (input.shortcut === 'next_publish') {
    return buildContentNextPriorityText(input.userId, input.topics, input.deskItems, input.signals, normalizedLocale);
  }
  if (input.shortcut === 'desk') {
    return buildContentDeskText(input.deskItems, normalizedLocale);
  }

  return buildContentPipelineSummaryText(input.data, input.locale);
}

function buildContentPillarsText(pillars: ContentPillarSummary[], locale: ChatCoreV2NormalizedLocale): string {
  if (pillars.length === 0) {
    if (locale === 'pt-BR') return 'Ainda não vejo pilares de conteúdo ativos. Configure isso em Conteúdo para a descoberta ficar focada.';
    if (locale === 'pt-PT') return 'Ainda não vejo pilares de conteúdo ativos. Configura-os em Conteúdo para a descoberta ficar focada.';
    if (locale === 'es') return 'Todavía no veo pilares de contenido activos. Configúralos en Contenido para mantener enfocada la detección.';
    return 'I do not see any active content pillars yet. Configure them in Content so discovery can stay focused.';
  }

  const lines = pillars.map((pillar) => {
    if (locale === 'en') return `- ${pillar.name} (${pillar.keywordCount} ${plural(pillar.keywordCount, 'keyword', 'keywords')})`;
    if (locale === 'es') return `- ${pillar.name} (${pillar.keywordCount} ${plural(pillar.keywordCount, 'palabra clave', 'palabras clave')})`;
    return `- ${pillar.name} (${pillar.keywordCount} ${plural(pillar.keywordCount, 'palavra-chave', 'palavras-chave')})`;
  });
  if (locale === 'pt-BR') return `Estes são os pilares que você está acompanhando agora:\n\n${lines.join('\n')}`;
  if (locale === 'pt-PT') return `Estes são os pilares que estás a acompanhar agora:\n\n${lines.join('\n')}`;
  if (locale === 'es') return `Estos son los pilares que estás siguiendo ahora:\n\n${lines.join('\n')}`;
  return `These are the pillars you are actively tracking right now:\n\n${lines.join('\n')}`;
}

function buildContentDeskText(items: ContentDeskItem[], locale: ChatCoreV2NormalizedLocale): string {
  if (items.length === 0) {
    if (locale === 'pt-BR') return 'Não há nada pronto na sua mesa agora. A mesa de conteúdo ainda está aquecendo.';
    if (locale === 'pt-PT') return 'Não há nada pronto na tua mesa agora. A mesa de conteúdo ainda está a aquecer.';
    if (locale === 'es') return 'No hay nada listo en tu mesa ahora. La mesa de contenido todavía se está preparando.';
    return 'There is nothing desk-ready right now. The content desk is still warming up.';
  }

  const lines = items.map((item) => `- ${item.title}${contentItemSuffix({
    entityId: contentDeskEntityId(item.id),
    title: item.title,
    kind: 'desk_item',
    status: item.type,
    scheduledDate: null,
    priority: null,
    createdAt: item.createdAt,
  }, locale)}`);
  if (locale === 'pt-BR') return `Isto já está na sua mesa agora:\n\n${lines.join('\n')}\n\nAbra Conteúdo para revisar, lapidar, ou empurrar estes itens no pipeline.`;
  if (locale === 'pt-PT') return `Isto já está na tua mesa agora:\n\n${lines.join('\n')}\n\nAbre Conteúdo para rever, lapidar, ou avançar estes itens no pipeline.`;
  if (locale === 'es') return `Esto ya está en tu mesa ahora:\n\n${lines.join('\n')}\n\nAbre Contenido para revisar, pulir o avanzar estos elementos en el pipeline.`;
  return `This is already on your desk right now:\n\n${lines.join('\n')}\n\nOpen Content to review, refine, or move these items forward.`;
}

function buildContentPerformanceText(userId: number, locale: ChatCoreV2NormalizedLocale): string {
  const summary = getPerformanceSummary(userId, 30);
  if (summary.count === 0) {
    if (locale === 'pt-BR') return 'Ainda não tenho performance de conteúdo registrada. Publique algo primeiro e depois consigo dizer o que está ganhando.';
    if (locale === 'pt-PT') return 'Ainda não tenho performance de conteúdo registada. Publica algo primeiro e depois consigo dizer o que está a ganhar.';
    if (locale === 'es') return 'Todavía no tengo rendimiento de contenido registrado. Publica algo primero y luego puedo decirte qué está ganando.';
    return 'I do not have any logged content performance yet. Publish something first, then I can tell you what is actually winning.';
  }

  const bestByViews = summary.entries.reduce((best, current) => current.views > best.views ? current : best, summary.entries[0]);
  const bestByRetention = summary.entries.reduce((best, current) => current.retentionPct > best.retentionPct ? current : best, summary.entries[0]);
  const viewsLine = locale === 'en'
    ? `- Best by views: ${bestByViews.videoUrl || 'Logged video'} (${formatContentNumber(bestByViews.views, locale)} views)`
    : `- Melhor em views: ${bestByViews.videoUrl || (locale === 'es' ? 'Video registrado' : 'Vídeo registado')} (${formatContentNumber(bestByViews.views, locale)} views)`;
  const retentionLine = locale === 'en'
    ? `- Best by retention: ${bestByRetention.videoUrl || 'Logged video'} (${bestByRetention.retentionPct}% retention)`
    : `- Melhor em retenção: ${bestByRetention.videoUrl || (locale === 'es' ? 'Video registrado' : 'Vídeo registado')} (${bestByRetention.retentionPct}% ${locale === 'es' ? 'de retención' : 'de retenção'})`;
  const averageLine = locale === 'en'
    ? `- 30-day average: ${formatContentNumber(summary.avgViews, locale)} views · ${summary.avgRetention}% retention`
    : `- Média de 30 dias: ${formatContentNumber(summary.avgViews, locale)} views · ${summary.avgRetention}% ${locale === 'es' ? 'de retención' : 'de retenção'}`;
  if (locale === 'pt-BR') return `Uma peça de conteúdo está liderando a sua performance recente.\n\n${viewsLine}\n${retentionLine}\n${averageLine}`;
  if (locale === 'pt-PT') return `Uma peça de conteúdo está a liderar a tua performance recente.\n\n${viewsLine}\n${retentionLine}\n${averageLine}`;
  if (locale === 'es') return `Una pieza de contenido está liderando tu rendimiento reciente.\n\n${viewsLine}\n${retentionLine}\n${averageLine}`;
  return `One content piece is leading your recent performance.\n\n${viewsLine}\n${retentionLine}\n${averageLine}`;
}

function buildContentLearningText(userId: number, locale: ChatCoreV2NormalizedLocale): string {
  const patterns = getLearnedPatterns(userId).slice(0, 3);
  if (patterns.length === 0) {
    const summary = getPerformanceSummary(userId, 30);
    if (summary.count > 0) {
      if (locale === 'en') {
        return `There is already performance history, but not a strong enough pattern yet to count as durable learning.\n\n- 30-day average: ${formatContentNumber(summary.avgViews, locale)} views · ${summary.avgRetention}% retention\n- Next step: log the hooks used and post-publish notes so the system can lock in what is working.`;
      }
      const averageLabel = locale === 'es' ? 'Media de 30 días' : 'Média de 30 dias';
      const nextStep = locale === 'es'
        ? 'Próximo paso: registra los hooks usados y las notas posteriores a la publicación para consolidar lo que funciona.'
        : 'Próximo passo: registar os hooks usados e as notas pós-publicação para consolidar o que está funcionando.';
      return `Já existe histórico de performance, mas ainda não há um padrão forte o suficiente para virar aprendizagem durável.\n\n- ${averageLabel}: ${formatContentNumber(summary.avgViews, locale)} views · ${summary.avgRetention}% ${locale === 'es' ? 'de retención' : 'de retenção'}\n- ${nextStep}`;
    }

    if (locale === 'pt-BR') return 'Ainda não existe aprendizagem suficiente registrada para responder com confiança. À medida que novos resultados e padrões entram, eu resumo o que está funcionando em hook, formato e retenção.';
    if (locale === 'pt-PT') return 'Ainda não existe aprendizagem suficiente registada para responder com confiança. À medida que novos resultados e padrões entram, eu resumo o que está a funcionar em hook, formato e retenção.';
    if (locale === 'es') return 'Todavía no hay aprendizaje registrado suficiente para responder con confianza. A medida que entren nuevos resultados y patrones, resumiré lo que funciona en hook, formato y retención.';
    return 'There is not enough logged learning yet to answer this confidently. As new results and patterns come in, I will summarize what is working across hooks, format, and retention.';
  }

  const lines = patterns.map((pattern) => {
    const confidence = Math.round(pattern.confidence * 100);
    return `- ${pattern.category.replace(/_/g, ' ')}: ${pattern.patternText} (${confidence}% confidence, seen ${pattern.frequency}x)`;
  });
  if (locale === 'pt-BR') return `Isto é o que o loop de aprendizagem está vendo agora:\n\n${lines.join('\n')}`;
  if (locale === 'pt-PT') return `Isto é o que o loop de aprendizagem está a ver agora:\n\n${lines.join('\n')}`;
  if (locale === 'es') return `Esto es lo que el ciclo de aprendizaje está detectando ahora:\n\n${lines.join('\n')}`;
  return `Here is what the learning loop is picking up right now:\n\n${lines.join('\n')}`;
}

function buildContentFilmingText(userId: number, locale: ChatCoreV2NormalizedLocale): string {
  const upcomingCount = getUpcomingTopicCount(userId, 7);
  const today = new Date();
  const dayLabel = formatContentDate(today.toISOString().slice(0, 10), locale);
  if (locale === 'pt-BR') {
    return `Esta é a melhor janela de filmagem que consigo inferir para esta semana:\n\n- Melhor dia: ${dayLabel}\n- Confiança: média\n- Tópicos agendados para os próximos 7 dias: ${upcomingCount}\n- Conecte o calendário em Configurações para eu reservar este bloco com mais precisão.`;
  }
  if (locale === 'pt-PT') {
    return `Esta é a melhor janela de filmagem que consigo inferir para esta semana:\n\n- Melhor dia: ${dayLabel}\n- Confiança: média\n- Tópicos agendados para os próximos 7 dias: ${upcomingCount}\n- Liga o calendário nas Definições para eu reservar este bloco com mais precisão.`;
  }
  if (locale === 'es') {
    return `Esta es la mejor ventana de grabación que puedo inferir para esta semana:\n\n- Mejor día: ${dayLabel}\n- Confianza: media\n- Temas programados para los próximos 7 días: ${upcomingCount}\n- Conecta el calendario en Ajustes para reservar este bloque con más precisión.`;
  }
  return `This is the best filming window I can infer for your week:\n\n- Best day: ${dayLabel}\n- Confidence: medium\n- Upcoming scheduled topics: ${upcomingCount}\n- Connect your calendar in Settings so I can reserve this block more precisely.`;
}

function buildContentNextPriorityText(
  userId: number,
  topics: ContentTopic[],
  deskItems: ContentDeskItem[],
  signals: ContentSignalDigest[],
  locale: ChatCoreV2NormalizedLocale,
): string {
  const nextTopic = chooseNextContentPriority(topics);
  if (nextTopic) {
    const status = statusLabel(nextTopic.status, locale);
    const scheduled = nextTopic.scheduled_date ? `\n- ${scheduledDatePhrase(nextTopic.scheduled_date, locale)}` : '';
    if (locale === 'pt-BR') return `Esta é a prioridade mais clara de conteúdo agora:\n\n- ${nextTopic.title}\n- Status: ${status}${scheduled}`;
    if (locale === 'pt-PT') return `Esta é a prioridade mais clara de conteúdo agora:\n\n- ${nextTopic.title}\n- Estado: ${status}${scheduled}`;
    if (locale === 'es') return `Esta es la prioridad de contenido más clara ahora:\n\n- ${nextTopic.title}\n- Estado: ${status}${scheduled}`;
    return `This is the clearest next content priority right now:\n\n- ${nextTopic.title}\n- Status: ${status}${scheduled}`;
  }

  const scriptReady = deskItems.find((item) => item.type === 'script_ready');
  if (scriptReady) {
    if (locale === 'pt-BR') return `O candidato mais claro para publicar a seguir já está na sua mesa:\n\n- ${scriptReady.title}\n\nAbra Conteúdo para rever o roteiro e avançar com ele.`;
    if (locale === 'pt-PT') return `O candidato mais claro para publicar a seguir já está na tua mesa:\n\n- ${scriptReady.title}\n\nAbre Conteúdo para rever o roteiro e avançar com ele.`;
    if (locale === 'es') return `El candidato más claro para publicar ya está en tu mesa:\n\n- ${scriptReady.title}\n\nAbre Contenido para revisar el guion y avanzarlo.`;
    return `The clearest next publish candidate is already on your desk:\n\n- ${scriptReady.title}\n\nOpen Content to review the script and move it forward.`;
  }

  const signal = signals.find((item) => item.priority === 'urgent') ?? signals[0] ?? null;
  if (signal) {
    if (locale === 'pt-BR') return `A jogada mais forte de conteúdo agora é reagir enquanto este sinal ainda está fresco:\n\n- ${signal.title}\n- Prioridade: ${signal.priority}\n\nAbra Conteúdo para transformar isto num roteiro ou bloco de captação.`;
    if (locale === 'pt-PT') return `A jogada mais forte de conteúdo agora é reagir enquanto este sinal ainda está fresco:\n\n- ${signal.title}\n- Prioridade: ${signal.priority}\n\nAbre Conteúdo para transformar isto num roteiro ou bloco de captação.`;
    if (locale === 'es') return `El movimiento de contenido más fuerte ahora es reaccionar mientras esta señal sigue fresca:\n\n- ${signal.title}\n- Prioridad: ${signal.priority}\n\nAbre Contenido para convertirlo en un guion o bloque de grabación.`;
    return `The strongest next content move is to react while this signal is still fresh:\n\n- ${signal.title}\n- Priority: ${signal.priority}\n\nOpen Content to turn this into a script or capture block.`;
  }

  // Keep a conservative filming suggestion when there is no publishable item.
  return buildContentFilmingText(userId, locale);
}

function chooseNextContentPriority(topics: ContentTopic[]): ContentTopic | null {
  const rankedStatuses: Array<ContentTopic['status']> = ['ready', 'drafting', 'planned'];
  for (const status of rankedStatuses) {
    const scheduled = topics.find((topic) => normalizeStatus(topic.status) === status && topic.scheduled_date);
    if (scheduled) return scheduled;
    const unscheduled = topics.find((topic) => normalizeStatus(topic.status) === status);
    if (unscheduled) return unscheduled;
  }
  return null;
}

function formatContentNumber(value: number, locale: ChatCoreV2NormalizedLocale): string {
  const formatterLocale = locale === 'en' ? 'en-US' : locale;
  return new Intl.NumberFormat(formatterLocale, { maximumFractionDigits: 0 }).format(value);
}

function formatContentDate(date: string, locale: ChatCoreV2NormalizedLocale): string {
  const formatterLocale = locale === 'en' ? 'en-US' : locale;
  return new Intl.DateTimeFormat(formatterLocale, {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  }).format(new Date(`${date}T12:00:00Z`));
}

function contentShortcutEntityId(shortcut: ContentStateShortcut): string {
  return `content_shortcut:${shortcut}`;
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
