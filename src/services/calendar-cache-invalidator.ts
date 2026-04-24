// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { clearCacheByPrefix } from './cache-store';
import { invalidateDashboardCoordinationCaches } from './coordination-cache-invalidator';

/**
 * Calendar writes affect raw calendar surfaces plus any downstream dashboard,
 * Home, and plan projections that derive from schedule truth.
 */
export function invalidateCalendarCaches(userId?: number): void {
  if (typeof userId === 'number' && Number.isFinite(userId)) {
    clearCacheByPrefix(`u:${userId}:calendar:`);
  }
  clearCacheByPrefix('calendar:');
  invalidateDashboardCoordinationCaches(userId);
}
