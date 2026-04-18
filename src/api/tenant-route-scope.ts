// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response } from 'express';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../services/tenant-scope-observability';

export function ensureValidTenantRouteScope(
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
): userId is number {
  if (isValidTenantUserId(userId)) return true;
  recordTenantScopeAnomaly({
    layer: 'delivery',
    operation,
    reason: 'invalid_user_scope',
    userId: typeof userId === 'number' ? userId : null,
    details,
  });
  res.status(401).json({
    ok: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'Invalid authenticated user scope',
    },
  });
  return false;
}
