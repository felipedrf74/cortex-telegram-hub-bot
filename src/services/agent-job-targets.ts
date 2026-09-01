// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../utils/logger';
import { getDb } from './database';
import { getOwnerBootstrapTarget } from './user-service';

export interface AgentJobTenantTarget {
  tenantId: number;
  userId: number;
  telegramId: number | null;
}

export interface ActiveAgentJobTargetOptions {
  /** Only boot-time callers before migrations may opt into the owner bridge. */
  allowBootstrapFallback?: boolean;
}

export class AgentJobTargetEnumerationError extends Error {
  readonly code = 'AGENT_JOB_TARGET_ENUMERATION_FAILED';

  constructor(readonly errorName: string) {
    super('Active agent-job targets could not be enumerated');
    this.name = 'AgentJobTargetEnumerationError';
  }
}

function isPreBootstrapTableMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:\s*(?:main\.)?users\b/i.test(message);
}

/**
 * Return canonical active tenant/user pairs for governed scheduled jobs.
 * Runtime jobs never fan out across legacy Telegram allow-lists. The only
 * startup fallback is the explicit owner bootstrap identity.
 */
export function listActiveAgentJobTenantTargets(
  options: ActiveAgentJobTargetOptions = {},
): AgentJobTenantTarget[] {
  try {
    const rows = getDb().prepare(
      "SELECT id, telegram_id FROM users WHERE status = 'active'",
    ).all() as Array<{ id: number; telegram_id: number | null }>;
    const targets = rows.map((row) => {
      const id = Number(row.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new AgentJobTargetEnumerationError('InvalidActiveUserId');
      }
      return {
        tenantId: id,
        userId: id,
        telegramId: row.telegram_id ?? null,
      };
    });
    // An authoritative empty result is not a bootstrap failure and must not
    // reactivate an owner account that is no longer active.
    return targets;
  } catch (error) {
    if (options.allowBootstrapFallback && isPreBootstrapTableMissing(error)) {
      const ownerTarget = getOwnerBootstrapTarget();
      return ownerTarget
        ? [{
            tenantId: ownerTarget.tenantId,
            userId: ownerTarget.tenantId,
            telegramId: ownerTarget.telegramId,
          }]
        : [];
    }
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    logger.error(
      { operation: 'listActiveAgentJobTenantTargets', errorCode: errorName },
      'Active agent-job tenant query failed closed',
    );
    if (error instanceof AgentJobTargetEnumerationError) throw error;
    throw new AgentJobTargetEnumerationError(errorName);
  }
}
