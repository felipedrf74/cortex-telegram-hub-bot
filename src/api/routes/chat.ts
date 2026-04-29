// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { sendError } from '../response-helpers';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';
import { registerChatCallbackRoutes } from './chat-callback-routes';
import { clearChatActiveDomain, registerChatMessageRoutes } from './chat-message-routes';
import { registerChatHistoryRoutes } from './chat-history-routes';

function ensureValidChatRouteScope(
  res: Response,
  userId: number | undefined,
  tenantId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
): userId is number {
  if (isValidTenantUserId(userId) && tenantId === userId) return true;
  if (isValidTenantUserId(userId) && tenantId !== userId) {
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation,
      reason: 'tenant_mismatch',
      userId,
      details: {
        ...details,
        tenantId: typeof tenantId === 'number' ? tenantId : null,
      },
    });
    sendError(res, 'FORBIDDEN', 'Invalid tenant scope', 403);
    return false;
  }
  recordTenantScopeAnomaly({
    layer: 'delivery',
    operation,
    reason: 'invalid_user_scope',
    userId: typeof userId === 'number' ? userId : null,
    details,
  });
  sendError(res, 'UNAUTHORIZED', 'Invalid authenticated user scope', 401);
  return false;
}

export function chatRoutes(): Router {
  const router = Router();

  registerChatMessageRoutes(router, ensureValidChatRouteScope);
  registerChatCallbackRoutes(router, ensureValidChatRouteScope);
  registerChatHistoryRoutes(router, ensureValidChatRouteScope, {
    clearActiveDomain: clearChatActiveDomain,
  });

  return router;
}
