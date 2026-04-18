// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { clearCacheByPrefix } from './cache-store';
import { invalidateContextCache } from './context-engine';
import { invalidateSharedDecisionContextCache } from './shared-decision-context';

/**
 * Weekly plan + daily brief share the same decision inputs, and the AI-facing
 * daily context plus shared decision context depend on the same underlying
 * schedule / training / meals / finance / health truth. Any high-impact write
 * should invalidate all of them together so orchestration and prompts do not
 * drift apart for the next request.
 *
 * When a userId is present we scope the invalidation to that user's plan keys.
 * Call without a userId only for truly global invalidations.
 */
export function invalidatePlanningCaches(userId?: number): void {
  if (typeof userId === 'number' && Number.isFinite(userId)) {
    clearCacheByPrefix(`plan:week:u:${userId}:`);
    clearCacheByPrefix(`plan:today:u:${userId}:`);
    invalidateSharedDecisionContextCache(userId);
    invalidateContextCache(userId);
    return;
  }

  clearCacheByPrefix('plan:week:u:');
  clearCacheByPrefix('plan:today:u:');
  invalidateSharedDecisionContextCache();
  invalidateContextCache();
}
