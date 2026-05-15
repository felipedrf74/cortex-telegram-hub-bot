// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { invalidateCalendarCaches } from './calendar-cache-invalidator';
import { invalidateExecutiveBriefCaches } from './coordination-cache-invalidator';

export interface InvalidateCookingDerivedCachesOptions {
  includeCalendarSurfaces?: boolean;
}

/**
 * Most cooking writes affect the Home executive brief + planning surfaces via
 * meal coverage, grocery readiness, and weekly coordination. Only writes that
 * create a real calendar event should fan out to the calendar-backed family.
 */
export function invalidateCookingDerivedCaches(
  userId?: number,
  options: InvalidateCookingDerivedCachesOptions = {},
): void {
  if (options.includeCalendarSurfaces) {
    invalidateCalendarCaches(userId);
    return;
  }

  invalidateExecutiveBriefCaches(userId);
}
