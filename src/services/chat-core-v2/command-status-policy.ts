// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DecisionApiItem } from '../decision-center';
import type { NotificationCenterItem } from '../notification-orchestrator';
import { hashStable } from './deterministic-read/common';

export const NOTIFICATION_SNOOZE_ELIGIBLE_STATUSES = ['unread', 'read'] as const;
export const DECISION_DISMISS_ELIGIBLE_STATUSES = ['unread', 'read', 'failed', 'snoozed'] as const;

export function isNotificationSnoozeEligibleStatus(status: string | null | undefined): boolean {
  return typeof status === 'string'
    && (NOTIFICATION_SNOOZE_ELIGIBLE_STATUSES as readonly string[]).includes(status);
}

export function isDecisionDismissEligibleStatus(status: string | null | undefined): boolean {
  return typeof status === 'string'
    && (DECISION_DISMISS_ELIGIBLE_STATUSES as readonly string[]).includes(status);
}

export function notificationSnoozeVersionForItem(item: NotificationCenterItem): string {
  return hashStable({
    title: item.title,
    safeBody: item.safeBody || item.body,
    sourceSkill: item.sourceSkill,
    type: item.type,
    priority: item.priority,
    actions: item.actions.map((action) => ({
      id: action.id,
      label: action.label,
      style: action.style ?? null,
    })),
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  });
}

export function decisionDismissVersionForItem(item: DecisionApiItem): string {
  return hashStable({
    decisionId: item.decisionId,
    title: item.title,
    summary: item.summary,
    safePreviewTitle: item.safePreviewTitle,
    safePreviewBody: item.safePreviewBody,
    urgency: item.urgency,
    sourceSkill: item.sourceSkill,
    type: item.type,
    actions: item.actions.map((action) => ({ id: action.id, label: action.label, style: action.style ?? null })),
    expiresAt: item.expiresAt,
  });
}
