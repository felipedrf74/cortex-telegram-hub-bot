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
  clearCache(`readiness:${userId}`);
  // training-home and training-summary keys are tenant-first
  // (`training-home:{tenantId}:{userId}:{language}`,
  // `training-summary:{tenantId}:{userId}`), so a user-scoped exact
  // key or prefix cannot target them; clear the whole family by prefix
  // instead, mirroring cache-coherence-registry's training.changed
  // handler (300s TTL, rare event). RERUN-2 finding 3 follow-up,
  // 2026-06-12: the previous `training-home:{userId}:` prefix never
  // matched the tenant-first route key, leaving the home view-state
  // stale for its full TTL after onboarding answers landed.
  clearCacheByPrefix(['training-home:', 'training-summary:']);
  invalidateDashboardCaches(userId);
  invalidatePlanningCaches(userId);
}
