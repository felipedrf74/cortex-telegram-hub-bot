// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { clearCache, clearCacheByPrefix } from './cache-store';
import { invalidateDashboardCaches } from './dashboard-cache-invalidator';
import { invalidatePlanningCaches } from './plan-cache-invalidator';

/**
 * Training-derived surfaces include the training home card, summary, coach
 * briefing, readiness, dashboard projections, and plan orchestration.
 */
export function invalidateTrainingDerivedCaches(userId: number): void {
  clearCache(`coach-briefing:${userId}`);
  clearCache(`training-summary:${userId}`);
  clearCache(`readiness:${userId}`);
  clearCacheByPrefix(`training-home:${userId}:`);
  invalidateDashboardCaches(userId);
  invalidatePlanningCaches(userId);
}
