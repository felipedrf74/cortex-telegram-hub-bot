// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { clearCache, clearCacheByPrefix } from './cache-store';
import { invalidateContextCache } from './context-engine';
import { invalidateSharedDecisionContextCache } from './shared-decision-context';
import { isValidTenantUserId } from './tenant-scope-observability';
import type { OAuthProvider } from './oauth-store';

export interface DashboardCacheInvalidationStats {
  requestCount: number;
  userScopedRequestCount: number;
  globalRequestCount: number;
  clearCountRequested: number;
  clearByPrefixCountRequested: number;
  lastInvalidatedAt: string | null;
  lastUserId: number | null;
}

export interface InvalidateCookingDerivedCachesOptions {
  includeCalendarSurfaces?: boolean;
}

export interface InvalidateTaskCachesOptions {
  userId?: number;
  listIds?: Array<string | null | undefined>;
  includeDerivedSurfaces?: boolean;
}

type DashboardCacheFamily = 'readiness' | 'root' | 'home';

const TRAINING_PROFILE_TYPES = new Set([
  'fitness',
  'triathlon-gym',
  'triathlon-running',
  'triathlon-cycling',
  'triathlon-swim',
]);

const dashboardCacheInvalidationStats: DashboardCacheInvalidationStats = {
  requestCount: 0,
  userScopedRequestCount: 0,
  globalRequestCount: 0,
  clearCountRequested: 0,
  clearByPrefixCountRequested: 0,
  lastInvalidatedAt: null,
  lastUserId: null,
};

export type CacheCoherenceEvent =
  | { type: 'calendar.changed'; userId?: number }
  | { type: 'content.changed'; userId?: number }
  | { type: 'cooking.changed'; userId?: number; includeCalendarSurfaces?: boolean }
  | { type: 'dashboard.all'; userId?: number }
  | { type: 'dashboard.home'; userId?: number }
  | { type: 'dashboard.readiness'; userId?: number }
  | { type: 'dashboard.root'; userId?: number }
  | { type: 'finance.changed'; userId?: number }
  | { type: 'integration.changed'; userId: number; provider: OAuthProvider | string }
  | { type: 'onboarding.changed'; userId: number; questionnaireId: string }
  | { type: 'planning.changed'; userId?: number }
  | { type: 'coordination.executive_brief'; userId?: number }
  | { type: 'coordination.dashboard'; userId?: number }
  | { type: 'task.changed'; options?: InvalidateTaskCachesOptions }
  | { type: 'training.changed'; userId: number };

export const CacheCoherenceEvents = {
  calendarChanged(userId?: number): CacheCoherenceEvent {
    return { type: 'calendar.changed', userId };
  },
  contentChanged(userId?: number): CacheCoherenceEvent {
    return { type: 'content.changed', userId };
  },
  cookingChanged(
    userId?: number,
    options: InvalidateCookingDerivedCachesOptions = {},
  ): CacheCoherenceEvent {
    return { type: 'cooking.changed', userId, includeCalendarSurfaces: options.includeCalendarSurfaces };
  },
  dashboardAll(userId?: number): CacheCoherenceEvent {
    return { type: 'dashboard.all', userId };
  },
  dashboardHome(userId?: number): CacheCoherenceEvent {
    return { type: 'dashboard.home', userId };
  },
  dashboardReadiness(userId?: number): CacheCoherenceEvent {
    return { type: 'dashboard.readiness', userId };
  },
  dashboardRoot(userId?: number): CacheCoherenceEvent {
    return { type: 'dashboard.root', userId };
  },
  financeChanged(userId?: number): CacheCoherenceEvent {
    return { type: 'finance.changed', userId };
  },
  integrationChanged(userId: number, provider: OAuthProvider | string): CacheCoherenceEvent {
    return { type: 'integration.changed', userId, provider };
  },
  onboardingChanged(userId: number, questionnaireId: string): CacheCoherenceEvent {
    return { type: 'onboarding.changed', userId, questionnaireId };
  },
  planningChanged(userId?: number): CacheCoherenceEvent {
    return { type: 'planning.changed', userId };
  },
  executiveBrief(userId?: number): CacheCoherenceEvent {
    return { type: 'coordination.executive_brief', userId };
  },
  dashboardCoordination(userId?: number): CacheCoherenceEvent {
    return { type: 'coordination.dashboard', userId };
  },
  taskChanged(options: InvalidateTaskCachesOptions = {}): CacheCoherenceEvent {
    return { type: 'task.changed', options };
  },
  trainingChanged(userId: number): CacheCoherenceEvent {
    return { type: 'training.changed', userId };
  },
} as const;

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

function isFiniteUserId(userId: unknown): userId is number {
  return typeof userId === 'number' && Number.isFinite(userId);
}

function recordDashboardCacheInvalidation(
  families: DashboardCacheFamily[],
  userId?: number,
): void {
  dashboardCacheInvalidationStats.requestCount += 1;
  dashboardCacheInvalidationStats.lastInvalidatedAt = new Date().toISOString();

  if (isFiniteUserId(userId)) {
    dashboardCacheInvalidationStats.userScopedRequestCount += 1;
    dashboardCacheInvalidationStats.lastUserId = userId;
  } else {
    dashboardCacheInvalidationStats.globalRequestCount += 1;
    dashboardCacheInvalidationStats.lastUserId = null;
  }

  for (const family of families) {
    if (family === 'readiness') {
      if (isFiniteUserId(userId)) {
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
  const prefixInvalidations: string[] = [];
  if (isFiniteUserId(userId)) {
    for (const family of families) {
      switch (family) {
        case 'readiness':
          clearCache(`dashboard-readiness:${userId}`);
          break;
        case 'root':
          prefixInvalidations.push(`dashboard:${userId}:`);
          break;
        case 'home':
          prefixInvalidations.push(`dashboard-home:${userId}:`);
          break;
      }
    }
    clearCacheByPrefix(prefixInvalidations);
    return;
  }

  for (const family of families) {
    switch (family) {
      case 'readiness':
        prefixInvalidations.push('dashboard-readiness:');
        break;
      case 'root':
        prefixInvalidations.push('dashboard:');
        break;
      case 'home':
        prefixInvalidations.push('dashboard-home:');
        break;
    }
  }
  clearCacheByPrefix(prefixInvalidations);
}

function invalidateDashboardCacheFamilies(
  families: DashboardCacheFamily[],
  userId?: number,
): void {
  recordDashboardCacheInvalidation(families, userId);
  performDashboardCacheInvalidation(families, userId);
}

export function invalidateCacheForEvent(event: CacheCoherenceEvent): void {
  switch (event.type) {
    case 'calendar.changed':
      clearCacheByPrefix([
        ...(isFiniteUserId(event.userId) ? [`u:${event.userId}:calendar:`] : []),
        'calendar:',
      ]);
      invalidateCacheForEvent(CacheCoherenceEvents.dashboardCoordination(event.userId));
      return;

    case 'content.changed':
      invalidateCacheForEvent(CacheCoherenceEvents.dashboardCoordination(event.userId));
      return;

    case 'cooking.changed':
      if (event.includeCalendarSurfaces) {
        invalidateCacheForEvent(CacheCoherenceEvents.calendarChanged(event.userId));
        return;
      }
      invalidateCacheForEvent(CacheCoherenceEvents.executiveBrief(event.userId));
      return;

    case 'dashboard.all':
      invalidateDashboardCacheFamilies(['readiness', 'root', 'home'], event.userId);
      return;

    case 'dashboard.home':
      invalidateDashboardCacheFamilies(['home'], event.userId);
      return;

    case 'dashboard.readiness':
      invalidateDashboardCacheFamilies(['readiness'], event.userId);
      return;

    case 'dashboard.root':
      invalidateDashboardCacheFamilies(['root'], event.userId);
      return;

    case 'finance.changed':
      invalidateCacheForEvent(CacheCoherenceEvents.executiveBrief(event.userId));
      return;

    case 'integration.changed':
      if (!isValidTenantUserId(event.userId)) return;
      switch (event.provider) {
        case 'google':
          invalidateCacheForEvent(CacheCoherenceEvents.calendarChanged(event.userId));
          invalidateCacheForEvent(CacheCoherenceEvents.financeChanged(event.userId));
          return;

        case 'outlook':
          invalidateCacheForEvent(CacheCoherenceEvents.calendarChanged(event.userId));
          invalidateCacheForEvent(CacheCoherenceEvents.financeChanged(event.userId));
          invalidateCacheForEvent(CacheCoherenceEvents.taskChanged({
            userId: event.userId,
            includeDerivedSurfaces: true,
          }));
          return;

        case 'todoist':
        case 'notion':
          invalidateCacheForEvent(CacheCoherenceEvents.taskChanged({
            userId: event.userId,
            includeDerivedSurfaces: true,
          }));
          return;

        case 'strava':
        case 'whoop':
        case 'fitbit':
        case 'garmin':
          invalidateCacheForEvent(CacheCoherenceEvents.trainingChanged(event.userId));
          return;

        default:
          invalidateCacheForEvent(CacheCoherenceEvents.executiveBrief(event.userId));
          return;
      }

    case 'onboarding.changed':
      if (!Number.isFinite(event.userId)) return;
      if (TRAINING_PROFILE_TYPES.has(event.questionnaireId)) {
        invalidateCacheForEvent(CacheCoherenceEvents.trainingChanged(event.userId));
        return;
      }
      if (event.questionnaireId === 'diet') {
        invalidateCacheForEvent(CacheCoherenceEvents.cookingChanged(event.userId));
        return;
      }
      invalidateCacheForEvent(CacheCoherenceEvents.executiveBrief(event.userId));
      return;

    case 'planning.changed':
      if (isFiniteUserId(event.userId)) {
        clearCacheByPrefix([
          `plan:week:u:${event.userId}:`,
          `plan:today:u:${event.userId}:`,
        ]);
        invalidateSharedDecisionContextCache(event.userId);
        invalidateContextCache(event.userId);
        return;
      }
      clearCacheByPrefix(['plan:week:u:', 'plan:today:u:']);
      invalidateSharedDecisionContextCache();
      invalidateContextCache();
      return;

    case 'coordination.executive_brief':
      invalidateCacheForEvent(CacheCoherenceEvents.dashboardHome(event.userId));
      invalidateCacheForEvent(CacheCoherenceEvents.planningChanged(event.userId));
      return;

    case 'coordination.dashboard':
      invalidateCacheForEvent(CacheCoherenceEvents.dashboardRoot(event.userId));
      invalidateCacheForEvent(CacheCoherenceEvents.executiveBrief(event.userId));
      return;

    case 'task.changed': {
      const { userId, listIds = [], includeDerivedSurfaces = true } = event.options ?? {};
      const prefixes = isFiniteUserId(userId) ? [`u:${userId}:`, ''] : [''];
      const listPrefixes: string[] = [];

      for (const prefix of prefixes) {
        clearCache(`${prefix}task-lists`);
        clearCache(`${prefix}tasks-working-set`);
        clearCache(`${prefix}fastpath:pending-tasks`);
        clearCache(`${prefix}tasks-filtered:all`);
        clearCache(`${prefix}tasks-filtered:overdue`);
        clearCache(`${prefix}tasks-filtered:dueToday`);

        for (const listId of listIds) {
          if (!listId) continue;
          listPrefixes.push(`${prefix}tasks:${listId}:`);
        }
      }
      clearCacheByPrefix(listPrefixes);

      if (includeDerivedSurfaces) {
        invalidateCacheForEvent(CacheCoherenceEvents.dashboardCoordination(userId));
      }
      return;
    }

    case 'training.changed':
      clearCache(`coach-briefing:${event.userId}`);
      clearCache(`training-summary:${event.userId}`);
      clearCache(`readiness:${event.userId}`);
      clearCacheByPrefix([`training-home:${event.userId}:`]);
      invalidateCacheForEvent(CacheCoherenceEvents.dashboardAll(event.userId));
      invalidateCacheForEvent(CacheCoherenceEvents.planningChanged(event.userId));
      return;
  }
}

export function invalidateCalendarCaches(userId?: number): void {
  invalidateCacheForEvent(CacheCoherenceEvents.calendarChanged(userId));
}

export function invalidateContentDerivedCaches(userId?: number): void {
  invalidateCacheForEvent(CacheCoherenceEvents.contentChanged(userId));
}

export function invalidateCookingDerivedCaches(
  userId?: number,
  options: InvalidateCookingDerivedCachesOptions = {},
): void {
  invalidateCacheForEvent(CacheCoherenceEvents.cookingChanged(userId, options));
}

export function invalidateDashboardCaches(userId?: number): void {
  invalidateCacheForEvent(CacheCoherenceEvents.dashboardAll(userId));
}

export function invalidateDashboardHomeCaches(userId?: number): void {
  invalidateCacheForEvent(CacheCoherenceEvents.dashboardHome(userId));
}

export function invalidateDashboardReadinessCaches(userId?: number): void {
  invalidateCacheForEvent(CacheCoherenceEvents.dashboardReadiness(userId));
}

export function invalidateDashboardRootCaches(userId?: number): void {
  invalidateCacheForEvent(CacheCoherenceEvents.dashboardRoot(userId));
}

export function invalidateDashboardCoordinationCaches(userId?: number): void {
  invalidateCacheForEvent(CacheCoherenceEvents.dashboardCoordination(userId));
}

export function invalidateExecutiveBriefCaches(userId?: number): void {
  invalidateCacheForEvent(CacheCoherenceEvents.executiveBrief(userId));
}

export function invalidateFinanceDerivedCaches(userId?: number): void {
  invalidateCacheForEvent(CacheCoherenceEvents.financeChanged(userId));
}

export function invalidateIntegrationDerivedCaches(
  userId: number,
  provider: OAuthProvider | string,
): void {
  invalidateCacheForEvent(CacheCoherenceEvents.integrationChanged(userId, provider));
}

export function invalidateOnboardingDerivedCaches(
  userId: number,
  questionnaireId: string,
): void {
  invalidateCacheForEvent(CacheCoherenceEvents.onboardingChanged(userId, questionnaireId));
}

export function invalidatePlanningCaches(userId?: number): void {
  invalidateCacheForEvent(CacheCoherenceEvents.planningChanged(userId));
}

export function invalidateTaskCaches(options: InvalidateTaskCachesOptions = {}): void {
  invalidateCacheForEvent(CacheCoherenceEvents.taskChanged(options));
}

export function invalidateTrainingDerivedCaches(userId: number): void {
  invalidateCacheForEvent(CacheCoherenceEvents.trainingChanged(userId));
}
