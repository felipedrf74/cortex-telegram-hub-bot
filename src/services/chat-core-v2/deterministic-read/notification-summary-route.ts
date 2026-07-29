// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  listNotificationCenterItems,
  type NotificationCenterItem,
} from '../../notification-orchestrator';
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
  MAX_NOTIFICATION_SCAN,
  MAX_VISIBLE_NOTIFICATIONS,
  NOTIFICATIONS_SUMMARY_CAPABILITY,
  hashStable,
} from './common';
import { joinParts, plural, type ChatCoreV2NormalizedLocale } from './copy';
import type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2DeterministicReadRouteResult,
  ChatCoreV2NotificationSummaryData,
  ChatCoreV2NotificationSummaryItem,
} from './types';
import type { ChatCoreV2ShadowRouteGuess } from '../shadow-route-classifier';

export function buildNotificationsSummaryRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2DeterministicReadRouteResult | null {
  const now = input.now ?? new Date();
  const notifications = listNotificationCenterItems(input.userId, input.tenantId, {
    status: 'unread',
    limit: MAX_NOTIFICATION_SCAN,
  });
  const data = summarizeNotifications(notifications);
  const readModel = buildChatCoreV2ReadModelResult<ChatCoreV2NotificationSummaryData>({
    capabilityId: NOTIFICATIONS_SUMMARY_CAPABILITY,
    domain: 'notifications',
    data,
    sourceEntityIds: data.topItems.map((item) => item.entityId),
    sourceVersions: sourceVersionsForNotifications(notifications),
    generatedAt: now.toISOString(),
    maxSourceAgeSeconds: 60,
    sensitivity: 'personal',
    summary: buildNotificationsSummaryText(data, input.locale),
    locale: normalizeChatCoreV2Locale(input.locale),
    now,
  });
  if (!isReadModelFreshEnough(readModel)) return null;

  const contextPack = buildChatCoreV2ReadContextPack([readModel], { generatedAt: now.toISOString() });
  const response = buildChatCoreV2MessageResponse({
    text: readModel.summary ?? buildNotificationsSummaryText(data, input.locale),
    locale: input.locale,
    reasonCodes: ['deterministic_read', NOTIFICATIONS_SUMMARY_CAPABILITY],
  });

  return {
    capabilityId: NOTIFICATIONS_SUMMARY_CAPABILITY,
    routeGuess,
    readModel,
    contextPack,
    response,
  };
}

function summarizeNotifications(items: NotificationCenterItem[]): ChatCoreV2NotificationSummaryData {
  const sorted = [...items].sort((a, b) => {
    const priorityRank = notificationPriorityRank(a.priority) - notificationPriorityRank(b.priority);
    if (priorityRank !== 0) return priorityRank;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
  return {
    unreadCount: items.length,
    urgentCount: items.filter((item) => item.priority === 'critical' || item.priority === 'time_sensitive').length,
    actionRequiredCount: items.filter((item) => notificationNeedsAction(item)).length,
    remindersCount: items.filter((item) => item.type === 'reminder').length,
    sourceSkills: [...new Set(items.map((item) => item.sourceSkill))].sort(),
    topItems: sorted.slice(0, MAX_VISIBLE_NOTIFICATIONS).map(notificationSummaryItem),
  };
}

function notificationSummaryItem(item: NotificationCenterItem): ChatCoreV2NotificationSummaryItem {
  return {
    entityId: notificationEntityId(item),
    title: item.title,
    body: item.safeBody || item.body,
    sourceSkill: item.sourceSkill,
    type: item.type,
    priority: item.priority,
    status: item.status,
    actionLabels: item.actions.map((action) => action.label).filter(Boolean),
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

function buildNotificationsSummaryText(
  data: ChatCoreV2NotificationSummaryData,
  locale: string | null | undefined,
): string {
  const normalizedLocale = normalizeChatCoreV2Locale(locale);
  if (data.unreadCount === 0) {
    if (normalizedLocale === 'pt-BR') return 'Você não tem notificações não lidas agora.';
    if (normalizedLocale === 'pt-PT') return 'Não tens notificações por ler neste momento.';
    return 'You have no unread notifications right now.';
  }

  const header = buildNotificationsSummaryHeader(data, normalizedLocale);
  if (data.topItems.length === 0) return header;
  const itemLines = data.topItems.map((item) => {
    const action = item.actionLabels[0] ? notificationActionSuffix(item.actionLabels[0], normalizedLocale) : '';
    return `- ${item.title}${notificationPrioritySuffix(item.priority, normalizedLocale)}${action}`;
  });
  return `${header}\n\n${notificationListLabel(normalizedLocale)}\n${itemLines.join('\n')}`;
}

function buildNotificationsSummaryHeader(
  data: ChatCoreV2NotificationSummaryData,
  locale: ChatCoreV2NormalizedLocale,
): string {
  const parts: string[] = [];
  if (data.urgentCount > 0) parts.push(notificationCountPhrase(data.urgentCount, locale, 'urgent'));
  if (data.actionRequiredCount > 0) parts.push(notificationCountPhrase(data.actionRequiredCount, locale, 'action_required'));
  if (data.remindersCount > 0) parts.push(notificationCountPhrase(data.remindersCount, locale, 'reminder'));
  const detail = parts.length > 0 ? ` ${joinParts(parts, locale)}` : '';

  if (locale === 'pt-BR') return `Você tem ${data.unreadCount} ${plural(data.unreadCount, 'notificação não lida', 'notificações não lidas')}.${detail}`;
  if (locale === 'pt-PT') return `Tens ${data.unreadCount} ${plural(data.unreadCount, 'notificação por ler', 'notificações por ler')}.${detail}`;
  return `You have ${data.unreadCount} unread ${data.unreadCount === 1 ? 'notification' : 'notifications'}.${detail}`;
}

function notificationCountPhrase(
  count: number,
  locale: ChatCoreV2NormalizedLocale,
  kind: 'urgent' | 'action_required' | 'reminder',
): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') {
    if (kind === 'urgent') return `${count} ${plural(count, 'urgente', 'urgentes')}`;
    if (kind === 'action_required') return `${count} ${plural(count, 'com ação necessária', 'com ação necessária')}`;
    return `${count} ${plural(count, 'lembrete', 'lembretes')}`;
  }
  if (kind === 'urgent') return `${count} urgent`;
  if (kind === 'action_required') return `${count} needing action`;
  return `${count} ${count === 1 ? 'reminder' : 'reminders'}`;
}

function notificationListLabel(locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR') return 'Principais notificações:';
  if (locale === 'pt-PT') return 'Notificações principais:';
  return 'Top notifications:';
}

function notificationPrioritySuffix(priority: string, locale: ChatCoreV2NormalizedLocale): string {
  if (priority === 'critical' || priority === 'time_sensitive') {
    if (locale === 'pt-BR' || locale === 'pt-PT') return ' (urgente)';
    return ' (urgent)';
  }
  return '';
}

function notificationActionSuffix(actionLabel: string, locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') return ` - ação: ${actionLabel}`;
  return ` - action: ${actionLabel}`;
}

function notificationNeedsAction(item: NotificationCenterItem): boolean {
  if (item.actions.some((action) => action.mutating || action.style === 'primary')) return true;
  return item.type === 'decision_required' || item.type === 'approval_required' || item.type === 'conflict_detected';
}

function sourceVersionsForNotifications(items: NotificationCenterItem[]): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const item of items) {
    versions[notificationEntityId(item)] = hashStable({
      title: item.title,
      safeBody: item.safeBody || item.body,
      sourceSkill: item.sourceSkill,
      type: item.type,
      priority: item.priority,
      status: item.status,
      actions: item.actions.map((action) => ({ id: action.id, label: action.label, style: action.style ?? null })),
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
    });
  }
  return versions;
}

function notificationEntityId(item: NotificationCenterItem): string {
  return `notification:${item.itemId}`;
}

function notificationPriorityRank(priority: string): number {
  if (priority === 'critical') return 0;
  if (priority === 'time_sensitive') return 1;
  if (priority === 'active') return 2;
  return 3;
}
