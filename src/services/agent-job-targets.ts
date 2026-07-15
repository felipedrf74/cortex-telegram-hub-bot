// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../utils/logger';
import { getDb } from './database';
import { getOwnerBootstrapTarget } from './user-service';

export interface AgentJobTenantTarget {
  tenantId: number;
  userId: number;
  telegramId: number | null;
}

function isPreBootstrapTableMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table/i.test(message);
}

/**
 * Return canonical active tenant/user pairs for governed scheduled jobs.
 * Runtime jobs never fan out across legacy Telegram allow-lists. The only
 * startup fallback is the explicit owner bootstrap identity.
 */
export function listActiveAgentJobTenantTargets(): AgentJobTenantTarget[] {
  try {
    const rows = getDb().prepare(
      "SELECT id, telegram_id FROM users WHERE status = 'active'",
    ).all() as Array<{ id: number; telegram_id: number | null }>;
    if (rows.length > 0) {
      return rows.flatMap((row) => {
        const id = Number(row.id);
        if (!Number.isSafeInteger(id) || id <= 0) {
          logger.warn({ operation: 'listActiveAgentJobTenantTargets' }, 'Invalid active user id skipped');
          return [];
        }
        return [{
          tenantId: id,
          userId: id,
          telegramId: row.telegram_id ?? null,
        }];
      });
    }
  } catch (error) {
    if (!isPreBootstrapTableMissing(error)) {
      logger.warn(
        { operation: 'listActiveAgentJobTenantTargets', errorCode: error instanceof Error ? error.name : 'UnknownError' },
        'Active agent-job tenant query failed',
      );
    }
  }

  const ownerTarget = getOwnerBootstrapTarget();
  return ownerTarget
    ? [{
        tenantId: ownerTarget.tenantId,
        userId: ownerTarget.tenantId,
        telegramId: ownerTarget.telegramId,
      }]
    : [];
}
