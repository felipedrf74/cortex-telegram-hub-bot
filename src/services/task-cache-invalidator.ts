// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { clearCache, clearCacheByPrefix } from './cache-store';
import { invalidateDashboardCoordinationCaches } from './coordination-cache-invalidator';

export interface InvalidateTaskCachesOptions {
  userId?: number;
  listIds?: Array<string | null | undefined>;
  includeDerivedSurfaces?: boolean;
}

/**
 * Task mutations must clear list-level task caches plus any derived dashboard
 * and Home/plan surfaces that depend on pending/due/overdue truth.
 */
export function invalidateTaskCaches(options: InvalidateTaskCachesOptions = {}): void {
  const { userId, listIds = [], includeDerivedSurfaces = true } = options;
  const prefixes = typeof userId === 'number' && Number.isFinite(userId)
    ? [`u:${userId}:`, '']
    : [''];

  for (const prefix of prefixes) {
    clearCache(`${prefix}task-lists`);
    clearCache(`${prefix}tasks-working-set`);
    clearCache(`${prefix}fastpath:pending-tasks`);
    clearCache(`${prefix}tasks-filtered:all`);
    clearCache(`${prefix}tasks-filtered:overdue`);
    clearCache(`${prefix}tasks-filtered:dueToday`);

    for (const listId of listIds) {
      if (!listId) continue;
      clearCacheByPrefix(`${prefix}tasks:${listId}:`);
    }
  }

  if (includeDerivedSurfaces) {
    invalidateDashboardCoordinationCaches(userId);
  }
}
