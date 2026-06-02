// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  listSecretaryAgendaItems,
  type SecretaryAgendaItem,
} from '../../secretary-scheduling-arbitrator';
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
  MAX_VISIBLE_AGENDA_ITEMS,
  SECRETARY_AGENDA_SUMMARY_CAPABILITY,
  hashStable,
  normalizeTimezone,
} from './common';
import { joinParts, plural, type ChatCoreV2NormalizedLocale } from './copy';
import type { ChatCoreV2ShadowRouteGuess } from '../shadow-route-classifier';
import type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2AgendaSummaryData,
  ChatCoreV2AgendaSummaryItem,
  ChatCoreV2DeterministicReadRouteResult,
} from './types';

export function buildAgendaSummaryRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2DeterministicReadRouteResult | null {
  const now = input.now ?? new Date();
  const timezone = normalizeTimezone(input.timezone);
  const agendaItems = listSecretaryAgendaItems({
    ownerUserId: input.userId,
    tenantId: input.tenantId,
    includeInactive: false,
  });
  const data = summarizeAgenda(agendaItems, timezone, now);
  const readModel = buildChatCoreV2ReadModelResult<ChatCoreV2AgendaSummaryData>({
    capabilityId: SECRETARY_AGENDA_SUMMARY_CAPABILITY,
    domain: 'secretary',
    data,
    sourceEntityIds: data.topItems.map((item) => item.entityId),
    sourceVersions: sourceVersionsForAgenda(agendaItems),
    generatedAt: now.toISOString(),
    maxSourceAgeSeconds: 60,
    sensitivity: 'personal',
    summary: buildAgendaSummaryText(data, input.locale),
    locale: normalizeChatCoreV2Locale(input.locale),
    now,
  });
  if (!isReadModelFreshEnough(readModel)) return null;

  const contextPack = buildChatCoreV2ReadContextPack([readModel], { generatedAt: now.toISOString() });
  const response = buildChatCoreV2MessageResponse({
    text: readModel.summary ?? buildAgendaSummaryText(data, input.locale),
    locale: input.locale,
    reasonCodes: ['deterministic_read', SECRETARY_AGENDA_SUMMARY_CAPABILITY],
  });

  return {
    capabilityId: SECRETARY_AGENDA_SUMMARY_CAPABILITY,
    routeGuess,
    readModel,
    contextPack,
    response,
  };
}

function summarizeAgenda(items: SecretaryAgendaItem[], timezone: string, now: Date): ChatCoreV2AgendaSummaryData {
  const today = dateKey(now.toISOString(), timezone) ?? now.toISOString().slice(0, 10);
  const mapped = items.map((item): ChatCoreV2AgendaSummaryItem => {
    const startKey = item.startAt ? dateKey(item.startAt, timezone) : null;
    const bucket: ChatCoreV2AgendaSummaryItem['bucket'] = startKey == null
      ? 'unscheduled'
      : startKey === today
        ? 'today'
        : 'upcoming';
    return {
      entityId: agendaEntityId(item),
      title: item.title,
      sourceSkill: item.sourceSkill,
      lifecycleState: item.lifecycleState,
      providerSyncState: item.providerSyncState,
      startAt: item.startAt,
      endAt: item.endAt,
      durationMinutes: item.durationMinutes,
      bucket,
    };
  });

  mapped.sort((a, b) => {
    const bucketRank = agendaBucketRank(a.bucket) - agendaBucketRank(b.bucket);
    if (bucketRank !== 0) return bucketRank;
    const aTime = a.startAt ? Date.parse(a.startAt) : Number.POSITIVE_INFINITY;
    const bTime = b.startAt ? Date.parse(b.startAt) : Number.POSITIVE_INFINITY;
    if (aTime !== bTime) return aTime - bTime;
    return a.title.localeCompare(b.title);
  });

  return {
    activeCount: items.length,
    todayCount: mapped.filter((item) => item.bucket === 'today').length,
    unscheduledCount: mapped.filter((item) => item.bucket === 'unscheduled').length,
    providerAttentionCount: items.filter((item) => providerNeedsAttention(item.providerSyncState)).length,
    timezone,
    topItems: mapped.slice(0, MAX_VISIBLE_AGENDA_ITEMS),
  };
}

function buildAgendaSummaryText(data: ChatCoreV2AgendaSummaryData, locale: string | null | undefined): string {
  const normalizedLocale = normalizeChatCoreV2Locale(locale);
  if (data.activeCount === 0) {
    if (normalizedLocale === 'pt-BR') return 'Sua agenda da Secretary está livre agora.';
    if (normalizedLocale === 'pt-PT') return 'A tua agenda da Secretary está livre neste momento.';
    if (normalizedLocale === 'es') return 'Tu agenda de Secretary está libre ahora.';
    return 'Your Secretary agenda is clear right now.';
  }

  const header = buildAgendaSummaryHeader(data, normalizedLocale);
  if (data.topItems.length === 0) return header;
  const itemLines = data.topItems.map((item) => `- ${item.title}${agendaItemSuffix(item, normalizedLocale)}`);
  return `${header}\n\n${agendaListLabel(normalizedLocale)}\n${itemLines.join('\n')}`;
}

function buildAgendaSummaryHeader(data: ChatCoreV2AgendaSummaryData, locale: ChatCoreV2NormalizedLocale): string {
  const parts: string[] = [];
  if (data.todayCount > 0) parts.push(agendaCountPhrase(data.todayCount, locale, 'today'));
  if (data.unscheduledCount > 0) parts.push(agendaCountPhrase(data.unscheduledCount, locale, 'unscheduled'));
  if (data.providerAttentionCount > 0) parts.push(agendaCountPhrase(data.providerAttentionCount, locale, 'provider_attention'));
  const detail = parts.length > 0 ? ` ${joinParts(parts, locale)}` : '';

  if (locale === 'pt-BR') return `A Secretary tem ${data.activeCount} ${plural(data.activeCount, 'item ativo', 'itens ativos')} na agenda.${detail}`;
  if (locale === 'pt-PT') return `A Secretary tem ${data.activeCount} ${plural(data.activeCount, 'item ativo', 'itens ativos')} na agenda.${detail}`;
  if (locale === 'es') return `Secretary tiene ${data.activeCount} ${plural(data.activeCount, 'elemento activo', 'elementos activos')} en la agenda.${detail}`;
  return `Secretary has ${data.activeCount} active agenda ${data.activeCount === 1 ? 'item' : 'items'}.${detail}`;
}

function agendaCountPhrase(
  count: number,
  locale: ChatCoreV2NormalizedLocale,
  kind: 'today' | 'unscheduled' | 'provider_attention',
): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') {
    if (kind === 'today') return `${count} ${plural(count, 'para hoje', 'para hoje')}`;
    if (kind === 'unscheduled') return `${count} ${plural(count, 'sem horário definido', 'sem horário definido')}`;
    return `${count} ${plural(count, 'precisa de verificação', 'precisam de verificação')}`;
  }
  if (locale === 'es') {
    if (kind === 'today') return `${count} ${plural(count, 'para hoy', 'para hoy')}`;
    if (kind === 'unscheduled') return `${count} ${plural(count, 'sin horario definido', 'sin horario definido')}`;
    return `${count} ${plural(count, 'necesita verificación', 'necesitan verificación')}`;
  }
  if (kind === 'today') return `${count} for today`;
  if (kind === 'unscheduled') return `${count} not timed yet`;
  return `${count} needing verification`;
}

function agendaListLabel(locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR') return 'Principais itens:';
  if (locale === 'pt-PT') return 'Itens principais:';
  if (locale === 'es') return 'Elementos principales:';
  return 'Top agenda items:';
}

function agendaItemSuffix(item: ChatCoreV2AgendaSummaryItem, locale: ChatCoreV2NormalizedLocale): string {
  const parts: string[] = [];
  if (item.bucket === 'today') {
    parts.push(locale === 'en' ? 'today' : locale === 'es' ? 'hoy' : 'hoje');
  } else if (item.bucket === 'unscheduled') {
    parts.push(locale === 'en' ? 'not timed yet' : locale === 'es' ? 'sin horario' : 'sem horário');
  }
  if (providerNeedsAttention(item.providerSyncState)) {
    parts.push(locale === 'en' ? 'needs verification' : locale === 'es' ? 'necesita verificación' : 'precisa de verificação');
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function sourceVersionsForAgenda(items: SecretaryAgendaItem[]): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const item of items) {
    versions[agendaEntityId(item)] = hashStable({
      title: item.title,
      lifecycleState: item.lifecycleState,
      providerSyncState: item.providerSyncState,
      startAt: item.startAt,
      endAt: item.endAt,
      durationMinutes: item.durationMinutes,
      sourceSkill: item.sourceSkill,
      updatedAt: item.updatedAt,
      version: item.version,
    });
  }
  return versions;
}

function agendaEntityId(item: SecretaryAgendaItem): string {
  return `secretary_agenda:${item.agendaItemId}`;
}

function agendaBucketRank(bucket: ChatCoreV2AgendaSummaryItem['bucket']): number {
  if (bucket === 'today') return 0;
  if (bucket === 'upcoming') return 1;
  return 2;
}

function providerNeedsAttention(state: string): boolean {
  return state === 'create_failed'
    || state === 'update_failed'
    || state === 'delete_failed'
    || state === 'readback_failed';
}

function dateKey(value: string, timezone: string): string | null {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return value.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(parsed);
    const part = (type: string) => parts.find((item) => item.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    return year && month && day ? `${year}-${month}-${day}` : parsed.toISOString().slice(0, 10);
  } catch {
    return parsed.toISOString().slice(0, 10);
  }
}
