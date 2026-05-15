// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { invalidateDashboardCoordinationCaches } from './coordination-cache-invalidator';

/**
 * Content writes affect creator workflow state plus the Home/plan surfaces that
 * summarize next-best creative action. Keep that ownership here so Content
 * routes do not need to know the exact downstream cache families.
 */
export function invalidateContentDerivedCaches(userId?: number): void {
  invalidateDashboardCoordinationCaches(userId);
}
