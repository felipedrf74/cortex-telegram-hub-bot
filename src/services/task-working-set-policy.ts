// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { TaskProviderType } from './task-store/task-router';

export type TaskListScope = 'active' | 'completed' | 'all';

export interface TaskProviderCapabilities {
  supportsActiveStatusFiltering: boolean;
  supportsCompletedRangeFiltering: boolean;
  supportsCursorPagination: boolean;
  supportsProviderSideListCounts: boolean;
  maxPageSize: number;
}

export interface TaskWorkingSetPolicy {
  policyVersion: string;
  activePageSize: number;
  completedPageSize: number;
  completedPolicy: {
    mode: 'recent_window' | 'cursor_only' | 'unavailable';
    suggestedCompletedAfter: string | null;
    pageSize: number;
    reasonCodes: string[];
  };
}

const POLICY_VERSION = 'task-working-set-v1';
const DEFAULT_ACTIVE_PAGE_SIZE = 75;
const DEFAULT_COMPLETED_PAGE_SIZE = 50;
const MAX_ACTIVE_PAGE_SIZE = 150;
const MAX_COMPLETED_PAGE_SIZE = 100;

export function getTaskProviderCapabilities(provider: TaskProviderType): TaskProviderCapabilities {
  switch (provider) {
    case 'ms_todo':
      return {
        supportsActiveStatusFiltering: true,
        supportsCompletedRangeFiltering: false,
        supportsCursorPagination: false,
        supportsProviderSideListCounts: false,
        maxPageSize: 100,
      };
    case 'todoist':
      return {
        supportsActiveStatusFiltering: true,
        supportsCompletedRangeFiltering: false,
        supportsCursorPagination: false,
        supportsProviderSideListCounts: false,
        maxPageSize: 100,
      };
    case 'nexus':
    default:
      return {
        supportsActiveStatusFiltering: true,
        supportsCompletedRangeFiltering: true,
        supportsCursorPagination: false,
        supportsProviderSideListCounts: false,
        maxPageSize: 100,
      };
  }
}

export function buildTaskWorkingSetPolicy(input: {
  provider: TaskProviderType;
  requestedPageSize?: unknown;
  requestedCompletedPageSize?: unknown;
}): TaskWorkingSetPolicy {
  const capabilities = getTaskProviderCapabilities(input.provider);
  const activePageSize = capTaskPageSize(
    input.requestedPageSize,
    DEFAULT_ACTIVE_PAGE_SIZE,
    Math.min(MAX_ACTIVE_PAGE_SIZE, capabilities.maxPageSize),
  );
  const completedPageSize = capTaskPageSize(
    input.requestedCompletedPageSize,
    DEFAULT_COMPLETED_PAGE_SIZE,
    Math.min(MAX_COMPLETED_PAGE_SIZE, capabilities.maxPageSize),
  );

  return {
    policyVersion: POLICY_VERSION,
    activePageSize,
    completedPageSize,
    completedPolicy: {
      mode: capabilities.supportsCompletedRangeFiltering ? 'recent_window' : 'cursor_only',
      suggestedCompletedAfter: capabilities.supportsCompletedRangeFiltering
        ? suggestedCompletedAfterIso()
        : null,
      pageSize: completedPageSize,
      reasonCodes: capabilities.supportsCompletedRangeFiltering
        ? ['provider_supports_completed_range']
        : ['provider_cursor_or_top_bounded_completed_history'],
    },
  };
}

export function capTaskPageSize(raw: unknown, fallback: number, max: number): number {
  const parsed = typeof raw === 'number'
    ? raw
    : typeof raw === 'string'
      ? Number.parseInt(raw, 10)
      : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

export function normalizeTaskListScope(raw: unknown, status?: unknown): TaskListScope {
  const scope = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (scope === 'active' || scope === 'completed' || scope === 'all') return scope;
  const statusValue = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (statusValue === 'active' || statusValue === 'pending') return 'active';
  if (statusValue === 'completed') return 'completed';
  return 'all';
}

export function statusForTaskScope(scope: TaskListScope, explicitStatus?: unknown): string | undefined {
  if (scope === 'active') return 'active';
  if (scope === 'completed') return 'completed';
  return typeof explicitStatus === 'string' && explicitStatus.trim() ? explicitStatus.trim() : undefined;
}

function suggestedCompletedAfterIso(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 30);
  return date.toISOString();
}
