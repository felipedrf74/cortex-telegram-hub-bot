// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { invalidateCalendarCaches } from './calendar-cache-invalidator';
import { invalidateExecutiveBriefCaches } from './coordination-cache-invalidator';
import { invalidateFinanceDerivedCaches } from './finance-cache-invalidator';
import { invalidateTaskCaches } from './task-cache-invalidator';
import { invalidateTrainingDerivedCaches } from './training-cache-invalidator';
import type { OAuthProvider } from './oauth-store';

/**
 * Provider connection state changes are product-state changes, not just token
 * mutations. A newly connected or disconnected provider can change Home,
 * today's plan, shared context, and skill availability in one request cycle.
 */
export function invalidateIntegrationDerivedCaches(
  userId: number,
  provider: OAuthProvider | string,
): void {
  if (!Number.isFinite(userId)) return;

  switch (provider) {
    case 'google':
      invalidateCalendarCaches(userId);
      invalidateFinanceDerivedCaches(userId);
      return;

    case 'outlook':
      invalidateCalendarCaches(userId);
      invalidateFinanceDerivedCaches(userId);
      invalidateTaskCaches({ userId, includeDerivedSurfaces: true });
      return;

    case 'todoist':
    case 'notion':
      invalidateTaskCaches({ userId, includeDerivedSurfaces: true });
      return;

    case 'strava':
    case 'whoop':
    case 'fitbit':
    case 'garmin':
      invalidateTrainingDerivedCaches(userId);
      return;

    default:
      invalidateExecutiveBriefCaches(userId);
  }
}
