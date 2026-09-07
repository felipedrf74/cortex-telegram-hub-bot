// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Client product-analytics ingest — POST /api/v1/analytics/events
 *
 * Write-only. Accepts only the locked v1.1 client-owned events:
 * app_open, onboarding_completed, paywall_viewed.
 *
 * Server-owned events (skill_first_success, decision_center_acted,
 * purchase_completed, model_access_denied, day7_retained) are rejected
 * here so clients cannot spoof verified outcomes.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import {
  emitProductAnalyticsEvent,
  isClientIngestEventName,
  isProductAnalyticsEventName,
  ProductAnalyticsValidationError,
} from '../../services/product-analytics';

export function analyticsRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'analytics_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /**
   * POST /api/v1/analytics/events
   * Body: { event: string, properties: object }
   */
  router.post('/events', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const body = (req.body || {}) as { event?: unknown; properties?: unknown };

    if (!isProductAnalyticsEventName(body.event)) {
      sendError(res, 'BAD_REQUEST', 'Unknown analytics event');
      return;
    }
    if (!isClientIngestEventName(body.event)) {
      sendError(res, 'BAD_REQUEST', 'Event is not client-ingestable');
      return;
    }

    try {
      const record = emitProductAnalyticsEvent({
        userId,
        tenantId: userId,
        event: body.event,
        properties: (body.properties && typeof body.properties === 'object' && !Array.isArray(body.properties))
          ? body.properties as Record<string, unknown>
          : {},
        source: 'ios',
      });
      sendSuccess(res, {
        accepted: true,
        eventId: record?.eventId ?? null,
      });
    } catch (err) {
      if (err instanceof ProductAnalyticsValidationError) {
        sendError(res, 'BAD_REQUEST', err.message);
        return;
      }
      sendInternalError(res, 'Failed to persist analytics event');
    }
  }));

  return router;
}
