// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Reaction Radar compatibility surface.
 *
 * The historical implementation mixed platform-global discovery, Brazil/
 * Portuguese defaults, user-owned channel data, and unscoped intelligence
 * signals. It has been removed rather than left dormant behind a lifecycle
 * flag: changing manifest metadata must never be enough to reactivate an
 * unsafe cross-tenant workflow.
 *
 * Rebuild requirements before this runner can become active:
 * - every discovery target and creator preference is tenant-user scoped;
 * - locale, region, pillars, scoring, and editorial stance come from the
 *   authenticated creator profile rather than process-wide defaults;
 * - emitted opportunities and duplicate detection are tenant-user scoped;
 * - provider/search cancellation, quota attribution, and bounded scheduling
 *   are enforced by the shared Content runtime contracts.
 */

import { logAgentRun } from '../services/intelligence-bus';
import { logger } from '../utils/logger';

const PAUSE_REASON = 'Paused until reaction discovery and emitted opportunities are tenant-user scoped';

export async function runReactionRadar(): Promise<void> {
  const start = Date.now();
  logger.info({ lifecycle: 'paused' }, `Reaction Radar skipped: ${PAUSE_REASON}`);
  logAgentRun('reaction-radar', 'skipped', 0, 0, Date.now() - start, PAUSE_REASON);
}
