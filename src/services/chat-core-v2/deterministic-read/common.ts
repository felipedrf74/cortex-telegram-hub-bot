// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';

export const TASKS_TODAY_SUMMARY_CAPABILITY = 'tasks.today_summary';
export const SECRETARY_AGENDA_SUMMARY_CAPABILITY = 'secretary.agenda_summary';
export const DECISION_CENTER_SUMMARY_CAPABILITY = 'decision_center.summary';
export const NOTIFICATIONS_SUMMARY_CAPABILITY = 'notifications.summary';
export const CONNECTIONS_STATUS_CAPABILITY = 'connections.status';
export const FINANCE_SUMMARY_CAPABILITY = 'finance.summary';
export const MAX_VISIBLE_TASKS = 5;
export const MAX_VISIBLE_AGENDA_ITEMS = 5;
export const MAX_VISIBLE_DECISIONS = 3;
export const MAX_VISIBLE_NOTIFICATIONS = 5;
export const MAX_VISIBLE_CONNECTIONS = 5;
export const MAX_NOTIFICATION_SCAN = 200;

export function normalizeTimezone(value: string | null | undefined): string {
  const timezone = String(value ?? '').trim();
  return timezone || 'UTC';
}

export function hashStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}
