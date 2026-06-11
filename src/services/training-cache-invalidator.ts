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
  // training-summary keys are tenant-first
  // (`training-summary:{tenantId}:{userId}`), so a user-scoped exact
  // key cannot target them; clear the whole family by prefix instead,
  // mirroring cache-coherence-registry's training.changed handler
  // (300s TTL, rare event).
  clearCacheByPrefix([`training-home:${userId}:`, 'training-summary:']);
  invalidateDashboardCaches(userId);
  invalidatePlanningCaches(userId);
}
