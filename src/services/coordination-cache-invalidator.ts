// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  invalidateDashboardHomeCaches,
  invalidateDashboardRootCaches,
} from './dashboard-cache-invalidator';
import { invalidatePlanningCaches } from './plan-cache-invalidator';

/**
 * Home executive brief is driven by dashboard-home plus the plan/today and
 * plan/week orchestration surfaces. Use this when a write changes cross-skill
 * reasoning without affecting dashboard root metrics like task counts.
 */
export function invalidateExecutiveBriefCaches(userId?: number): void {
  invalidateDashboardHomeCaches(userId);
  invalidatePlanningCaches(userId);
}

/**
 * Dashboard root + Home briefing + plan surfaces all need to move together
 * when a write affects app-visible operational truth like calendar, tasks,
 * content pipeline, or broader coordination state.
 */
export function invalidateDashboardCoordinationCaches(userId?: number): void {
  invalidateDashboardRootCaches(userId);
  invalidateExecutiveBriefCaches(userId);
}
