// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { clearCache, clearCacheByPrefix } from './cache-store';

export interface DashboardCacheInvalidationStats {
  requestCount: number;
  userScopedRequestCount: number;
  globalRequestCount: number;
  clearCountRequested: number;
  clearByPrefixCountRequested: number;
  lastInvalidatedAt: string | null;
  lastUserId: number | null;
}

const dashboardCacheInvalidationStats: DashboardCacheInvalidationStats = {
  requestCount: 0,
  userScopedRequestCount: 0,
  globalRequestCount: 0,
  clearCountRequested: 0,
  clearByPrefixCountRequested: 0,
  lastInvalidatedAt: null,
  lastUserId: null,
};

type DashboardCacheFamily = 'readiness' | 'root' | 'home';

export function getDashboardCacheInvalidationStats(): DashboardCacheInvalidationStats {
  return { ...dashboardCacheInvalidationStats };
}

export function _resetDashboardCacheInvalidationStatsForTests(): void {
  dashboardCacheInvalidationStats.requestCount = 0;
  dashboardCacheInvalidationStats.userScopedRequestCount = 0;
  dashboardCacheInvalidationStats.globalRequestCount = 0;
  dashboardCacheInvalidationStats.clearCountRequested = 0;
  dashboardCacheInvalidationStats.clearByPrefixCountRequested = 0;
  dashboardCacheInvalidationStats.lastInvalidatedAt = null;
  dashboardCacheInvalidationStats.lastUserId = null;
}

function recordDashboardCacheInvalidation(
  families: DashboardCacheFamily[],
  userId?: number,
): void {
  dashboardCacheInvalidationStats.requestCount += 1;
  dashboardCacheInvalidationStats.lastInvalidatedAt = new Date().toISOString();

  if (typeof userId === 'number' && Number.isFinite(userId)) {
    dashboardCacheInvalidationStats.userScopedRequestCount += 1;
    dashboardCacheInvalidationStats.lastUserId = userId;
  } else {
    dashboardCacheInvalidationStats.globalRequestCount += 1;
    dashboardCacheInvalidationStats.lastUserId = null;
  }

  for (const family of families) {
    if (family === 'readiness') {
      if (typeof userId === 'number' && Number.isFinite(userId)) {
        dashboardCacheInvalidationStats.clearCountRequested += 1;
      } else {
        dashboardCacheInvalidationStats.clearByPrefixCountRequested += 1;
      }
      continue;
    }
    dashboardCacheInvalidationStats.clearByPrefixCountRequested += 1;
  }
}

function performDashboardCacheInvalidation(
  families: DashboardCacheFamily[],
  userId?: number,
): void {
  if (typeof userId === 'number' && Number.isFinite(userId)) {
    for (const family of families) {
      switch (family) {
        case 'readiness':
          clearCache(`dashboard-readiness:${userId}`);
          break;
        case 'root':
          clearCacheByPrefix(`dashboard:${userId}:`);
          break;
        case 'home':
          clearCacheByPrefix(`dashboard-home:${userId}:`);
          break;
      }
    }
    return;
  }

  for (const family of families) {
    switch (family) {
      case 'readiness':
        clearCacheByPrefix('dashboard-readiness:');
        break;
      case 'root':
        clearCacheByPrefix('dashboard:');
        break;
      case 'home':
        clearCacheByPrefix('dashboard-home:');
        break;
    }
  }
}

function invalidateDashboardCacheFamilies(
  families: DashboardCacheFamily[],
  userId?: number,
): void {
  recordDashboardCacheInvalidation(families, userId);
  performDashboardCacheInvalidation(families, userId);
}

export function invalidateDashboardReadinessCaches(userId?: number): void {
  invalidateDashboardCacheFamilies(['readiness'], userId);
}

export function invalidateDashboardRootCaches(userId?: number): void {
  invalidateDashboardCacheFamilies(['root'], userId);
}

export function invalidateDashboardHomeCaches(userId?: number): void {
  invalidateDashboardCacheFamilies(['home'], userId);
}

/**
 * Keep all dashboard cache families coherent after any write that changes
 * calendar, task, readiness, or orchestration truth.
 */
export function invalidateDashboardCaches(userId?: number): void {
  invalidateDashboardCacheFamilies(['readiness', 'root', 'home'], userId);
}
