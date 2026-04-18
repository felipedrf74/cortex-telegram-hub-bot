// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../utils/logger';

export type TenantScopeAnomalyLayer =
  | 'intelligence_bus'
  | 'shared_decision_context'
  | 'mesh_context'
  | 'orchestration'
  | 'delivery';

export type TenantScopeAnomalyReason =
  | 'missing_user_scope'
  | 'invalid_user_scope'
  | 'unexpected_user_scope';

export interface TenantScopeAnomaly {
  layer: TenantScopeAnomalyLayer;
  operation: string;
  reason: TenantScopeAnomalyReason;
  userId: number | null;
  signalType?: string;
  details?: Record<string, unknown>;
  occurredAt: string;
}

const MAX_BUFFERED_ANOMALIES = 200;
const _tenantScopeAnomalies: TenantScopeAnomaly[] = [];

export function isValidTenantUserId(userId: number | null | undefined): userId is number {
  return typeof userId === 'number' && Number.isFinite(userId) && userId > 0;
}

export function recordTenantScopeAnomaly(
  anomaly: Omit<TenantScopeAnomaly, 'occurredAt'>,
): TenantScopeAnomaly {
  const entry: TenantScopeAnomaly = {
    ...anomaly,
    occurredAt: new Date().toISOString(),
  };

  _tenantScopeAnomalies.unshift(entry);
  if (_tenantScopeAnomalies.length > MAX_BUFFERED_ANOMALIES) {
    _tenantScopeAnomalies.length = MAX_BUFFERED_ANOMALIES;
  }

  logger.warn(
    {
      layer: entry.layer,
      operation: entry.operation,
      reason: entry.reason,
      userId: entry.userId,
      signalType: entry.signalType,
      details: entry.details,
    },
    'Tenant scope anomaly detected',
  );

  return entry;
}

export function getTenantScopeAnomalies(limit = 50): TenantScopeAnomaly[] {
  return _tenantScopeAnomalies.slice(0, Math.max(0, limit));
}

export function clearTenantScopeAnomaliesForTests(): void {
  _tenantScopeAnomalies.length = 0;
}
