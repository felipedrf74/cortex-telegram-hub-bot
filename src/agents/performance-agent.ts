// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Performance Intelligence compatibility surface.
 *
 * The historical implementation read user-owned YouTube data and wrote
 * platform-global intelligence signals. It has been removed rather than left
 * dormant behind a lifecycle flag so a manifest or scheduler edit cannot
 * accidentally reactivate a cross-tenant data path.
 *
 * Rebuild requirements before this runner can become active:
 * - channel selection, analytics, learned patterns, and emitted signals are
 *   tenant-user scoped end to end;
 * - pillar classification comes from the authenticated creator profile;
 * - provider/API cancellation, quota attribution, and bounded scheduling are
 *   enforced by the shared Content runtime contracts.
 */

import { logAgentRun } from '../services/intelligence-bus';
import { logger } from '../utils/logger';

const PAUSE_REASON = 'User-scoped performance signals not supported yet';

export async function runPerformanceAgent(): Promise<void> {
  const start = Date.now();
  logger.warn('Performance Agent paused: user-scoped content performance signals are not supported yet');
  logAgentRun('performance-agent', 'skipped', 0, 0, Date.now() - start, PAUSE_REASON);
}
