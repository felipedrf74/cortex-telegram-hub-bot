// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import type { NormalizedTask } from './types';

const TODOIST_NEXUS_MARKER_PREFIX = '<!-- nexus-task-id:';
const TODOIST_NEXUS_MARKER_SUFFIX = ' -->';
const TODOIST_NEXUS_MARKER_RE = /(?:\n\n)?<!-- nexus-task-id:([A-Za-z0-9_.:-]+) -->/;

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function normalizePriority(value: unknown): number {
  if (value === 'high') return 3;
  if (value === 'normal') return 2;
  if (value === 'low') return 1;
  const priority = Number(value || 0);
  return Number.isFinite(priority) ? priority : 0;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function todoistStatusFromProviderData(providerData: Record<string, unknown>): string | undefined {
  if (providerData.is_completed === true || providerData.checked === 1 || providerData.checked === true) return 'completed';
  if (providerData.is_completed === false || providerData.checked === 0 || providerData.checked === false) return 'pending';
  return undefined;
}

function normalizeStatus(value: unknown, providerData: Record<string, unknown>): string {
  const raw = normalizeText(value || todoistStatusFromProviderData(providerData));
  if (raw === 'notStarted' || raw === 'pending') return 'pending';
  if (raw === 'completed') return 'completed';
  return raw;
}

export function parseTodoistNexusMarker(description: unknown): { description: string | undefined; nexusTaskId?: string } {
  const raw = String(description || '');
  const match = raw.match(TODOIST_NEXUS_MARKER_RE);
  const stripped = match ? raw.replace(TODOIST_NEXUS_MARKER_RE, '').trim() : raw;
  return {
    description: stripped.trim().length > 0 ? stripped : undefined,
    nexusTaskId: match?.[1],
  };
}

export function appendTodoistNexusMarker(description: unknown, nexusTaskId?: string | null): string | undefined {
  const cleanDescription = parseTodoistNexusMarker(description).description || '';
  const cleanTaskId = String(nexusTaskId || '').trim();
  if (!cleanTaskId) return cleanDescription || undefined;
  const marker = `${TODOIST_NEXUS_MARKER_PREFIX}${cleanTaskId}${TODOIST_NEXUS_MARKER_SUFFIX}`;
  return cleanDescription ? `${cleanDescription}\n\n${marker}` : marker;
}

export function computeTaskContentFingerprint(task: Partial<NormalizedTask> & { providerData?: Record<string, unknown> }): string {
  const taskAny = task as Record<string, unknown>;
  const providerData = task.providerData || {};
  const due = providerData.due && typeof providerData.due === 'object' ? providerData.due as Record<string, unknown> : {};
  const fingerprintInput = {
    title: normalizeText(task.title ?? providerData.content),
    description: normalizeText(task.description ?? taskAny.body ?? parseTodoistNexusMarker(providerData.description).description),
    priority: normalizePriority(task.priority ?? taskAny.importance ?? providerData.priority),
    dueDate: normalizeText(task.dueDate ?? taskAny.dueDateTime ?? due.date ?? due.datetime),
    dueIsDatetime: Boolean(task.dueIsDatetime ?? (typeof taskAny.dueDateTime === 'string' && taskAny.dueDateTime.includes('T')) ?? due.datetime),
    tags: normalizeTags(task.tags ?? providerData.labels),
    status: normalizeStatus(task.status, providerData),
  };
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(fingerprintInput))
    .digest('hex')
    .slice(0, 32);
  return `fp:${hash}`;
}
