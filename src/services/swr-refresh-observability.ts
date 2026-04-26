// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../utils/logger';
import { recordOperatorAlert } from './operator-alerts';

const FAILURE_ALERT_THRESHOLD = 3;

interface SWRRefreshFailureState {
  consecutiveFailures: number;
  lastFailureAt: string;
  lastSuccessAt: string | null;
  lastErrorMessage: string;
}

const failureStateByKey = new Map<string, SWRRefreshFailureState>();

export function recordSWRRefreshSuccess(key: string): void {
  const existing = failureStateByKey.get(key);
  if (!existing) return;
  failureStateByKey.set(key, {
    ...existing,
    consecutiveFailures: 0,
    lastSuccessAt: new Date().toISOString(),
  });
}

export function recordSWRRefreshFailure(
  key: string,
  err: unknown,
  context?: {
    source?: string;
    userId?: number;
    operation?: string;
  },
): void {
  const existing = failureStateByKey.get(key);
  const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
  const errorMessage = err instanceof Error ? err.message : String(err ?? 'unknown error');
  const state: SWRRefreshFailureState = {
    consecutiveFailures,
    lastFailureAt: new Date().toISOString(),
    lastSuccessAt: existing?.lastSuccessAt ?? null,
    lastErrorMessage: errorMessage,
  };
  failureStateByKey.set(key, state);

  const logContext = {
    err,
    key,
    consecutiveFailures,
    source: context?.source,
    userId: context?.userId,
    operation: context?.operation,
  };

  if (consecutiveFailures < FAILURE_ALERT_THRESHOLD) {
    logger.warn(logContext, 'SWR background refresh failed');
    return;
  }

  logger.warn(logContext, 'SWR background refresh has repeated failures');
  try {
    recordOperatorAlert({
      severity: 'warning',
      source: 'swr_refresh',
      dedupeKey: `swr_refresh:${safeDedupeKey(key)}`,
      title: 'SWR background refresh failing',
      detail: `${consecutiveFailures} consecutive refresh failures for ${key}: ${errorMessage}`,
      owner: 'ops',
      suspectedArea: context?.source || 'cache_refresh',
      userImpact: 'The app may keep serving stale cached data for this surface until the provider recovers.',
      runbookUrl: 'docs/OBSERVABILITY-ONCALL.md#swr-refresh-alerts',
      metadata: {
        key,
        consecutiveFailures,
        source: context?.source,
        userId: context?.userId,
        operation: context?.operation,
        lastErrorMessage: errorMessage,
      },
    });
  } catch (alertErr) {
    logger.warn({ err: alertErr, key }, 'Failed to record SWR refresh operator alert');
  }
}

export function getSWRRefreshFailureSnapshot(): Record<string, SWRRefreshFailureState> {
  return Object.fromEntries(failureStateByKey.entries());
}

export function _resetSWRRefreshFailuresForTests(): void {
  failureStateByKey.clear();
}

function safeDedupeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 140);
}
