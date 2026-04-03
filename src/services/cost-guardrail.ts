// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cost Guardrail — global daily spend monitoring and alerting.
 *
 * Checks total API spend for the day against configurable limits.
 * Call after each AI API call to detect approaching/exceeding thresholds.
 */

import { getDb } from './database';
import { config } from '../config';
import { logger } from '../utils/logger';

let _lastAlertLevel: 'none' | 'warning' | 'critical' = 'none';

/**
 * Check global daily spend against configured limits.
 * Logs warning at threshold% and error at 100%.
 * Returns the current daily spend.
 */
export function checkGlobalCostGuardrail(): { totalUsd: number; limitUsd: number; exceeded: boolean } {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total
      FROM api_usage WHERE ts >= date('now')
    `).get() as { total: number };

    const limit = config.aiSafety.globalDailyLimitUsd;
    const threshold = limit * config.aiSafety.alertThresholdPercent;

    if (row.total >= limit && _lastAlertLevel !== 'critical') {
      logger.error({ total: row.total, limit }, 'GLOBAL COST LIMIT REACHED — AI calls should be throttled');
      _lastAlertLevel = 'critical';
    } else if (row.total >= threshold && _lastAlertLevel === 'none') {
      logger.warn({ total: row.total, threshold, limit }, 'Approaching global daily cost limit');
      _lastAlertLevel = 'warning';
    }

    // Reset alert level at start of new day
    if (row.total < threshold) {
      _lastAlertLevel = 'none';
    }

    return { totalUsd: row.total, limitUsd: limit, exceeded: row.total >= limit };
  } catch {
    return { totalUsd: 0, limitUsd: config.aiSafety.globalDailyLimitUsd, exceeded: false };
  }
}

/**
 * Get daily spend for a specific user (for portal display).
 */
export function getUserDailySpend(userId: number): { totalUsd: number; messageCount: number } {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total, COUNT(*) as count
      FROM api_usage
      WHERE user_id = ? AND ts >= date('now')
    `).get(userId) as { total: number; count: number };
    return { totalUsd: row.total, messageCount: row.count };
  } catch {
    return { totalUsd: 0, messageCount: 0 };
  }
}
