// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendSuccess } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import { secureSecretMatches } from '../secret-guards';
import {
  buildSkillDecisionFixtureIntent,
  createDecisionIntent,
  DecisionActionError,
  dismissDecision,
  getDecisionItem,
  getDecisionPreferences,
  getDecisionSummary,
  listDecisionItems,
  markDecisionViewed,
  performDecisionAction,
  snoozeDecision,
  updateDecisionPreferences,
  type DecisionUrgency,
} from '../../services/decision-center';
import {
  registerNotificationDeviceToken,
  revokeNotificationDeviceToken,
  type NotificationIntentType,
  type NotificationSourceSkill,
} from '../../services/notification-orchestrator';
import { isValidTenantUserId } from '../../services/tenant-scope-observability';
import { logger } from '../../utils/logger';

function routeTenantId(req: AuthenticatedRequest, userId: number): number {
  const candidate = req.tenantId;
  return isValidTenantUserId(candidate) ? candidate : userId;
}

function isInternalDecisionIntentRequest(req: AuthenticatedRequest): boolean {
  const expected = process.env.INTERNAL_API_SECRET || '';
  const provided = req.header('x-internal-secret');
  return Boolean(expected) && secureSecretMatches(expected, provided);
}

function decisionError(res: Response, err: unknown, fallbackCode = 'DECISION_ERROR'): void {
  if (err instanceof DecisionActionError) {
    sendError(res, err.code, err.message, err.status, err.details);
    return;
  }
  logger.warn({ err }, 'Decision route rejected request');
  sendError(res, fallbackCode, 'Unable to process decision request', 400);
}

export function decisionRoutes(): Router {
  const router = Router();

  router.get('/summary', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_summary')) return;
    const tenantId = routeTenantId(authReq, userId);
    const limit = parseInt(String(req.query.limit || '3'), 10);
    sendSuccess(res, getDecisionSummary(userId, tenantId, limit));
  }));

  router.get('/', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_list')) return;
    const tenantId = routeTenantId(authReq, userId);
    const limit = parseInt(String(req.query.limit || '80'), 10);
    const status = typeof req.query.status === 'string' ? req.query.status : 'all';
    const sourceSkill = typeof req.query.sourceSkill === 'string' ? req.query.sourceSkill as NotificationSourceSkill : undefined;
    const type = typeof req.query.type === 'string' ? req.query.type as NotificationIntentType : undefined;
    const urgency = typeof req.query.urgency === 'string' ? req.query.urgency as DecisionUrgency : undefined;
    const items = listDecisionItems(userId, tenantId, { status, sourceSkill, type, urgency, limit });
    sendSuccess(res, {
      count: items.length,
      openCount: items.filter((item) => ['unread', 'read', 'failed'].includes(item.status)).length,
      items,
    });
  }));

  router.post('/intents', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_create_intent')) return;
    if (!isInternalDecisionIntentRequest(authReq)) {
      sendError(res, 'FORBIDDEN', 'Decision intents are internal service events', 403);
      return;
    }
    const tenantId = routeTenantId(authReq, userId);
    try {
      const result = await createDecisionIntent({
        ...(req.body ?? {}),
        userId,
        tenantId,
      });
      sendSuccess(res, result, { status: result.item ? 201 : 202 });
    } catch (err) {
      decisionError(res, err, 'INVALID_DECISION_INTENT');
    }
  }));

  router.post('/intents/fixtures/:sourceSkill', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_fixture_intent')) return;
    if (!isInternalDecisionIntentRequest(authReq) && process.env.NODE_ENV === 'production') {
      sendError(res, 'FORBIDDEN', 'Decision fixtures are unavailable in production', 403);
      return;
    }
    const tenantId = routeTenantId(authReq, userId);
    try {
      const result = await createDecisionIntent(buildSkillDecisionFixtureIntent(
        String(req.params.sourceSkill || 'secretary') as NotificationSourceSkill,
        userId,
        {
          tenantId,
          ...(req.body ?? {}),
        },
      ));
      sendSuccess(res, result, { status: result.item ? 201 : 202 });
    } catch (err) {
      decisionError(res, err, 'INVALID_DECISION_FIXTURE');
    }
  }));

  router.get('/preferences', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_get_preferences')) return;
    const tenantId = routeTenantId(authReq, userId);
    sendSuccess(res, getDecisionPreferences(userId, tenantId));
  }));

  router.put('/preferences', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_update_preferences')) return;
    const tenantId = routeTenantId(authReq, userId);
    try {
      sendSuccess(res, updateDecisionPreferences(userId, tenantId, req.body ?? {}));
    } catch (err) {
      decisionError(res, err, 'INVALID_DECISION_PREFERENCES');
    }
  }));

  router.get('/:id', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_detail', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, userId);
    const item = getDecisionItem(String(req.params.id || ''), userId, tenantId);
    if (!item) {
      sendError(res, 'NOT_FOUND', 'Decision not found', 404);
      return;
    }
    sendSuccess(res, { item });
  }));

  router.patch('/:id/viewed', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_viewed', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, userId);
    try {
      sendSuccess(res, { item: markDecisionViewed(String(req.params.id || ''), userId, tenantId) });
    } catch (err) {
      decisionError(res, err, 'DECISION_VIEW_FAILED');
    }
  }));

  router.patch('/:id/snooze', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_snooze', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, userId);
    try {
      sendSuccess(res, { item: snoozeDecision(String(req.params.id || ''), userId, tenantId, Number(req.body?.minutes ?? 60)) });
    } catch (err) {
      decisionError(res, err, 'DECISION_SNOOZE_FAILED');
    }
  }));

  router.patch('/:id/dismiss', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_dismiss', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, userId);
    try {
      sendSuccess(res, { item: dismissDecision(String(req.params.id || ''), userId, tenantId) });
    } catch (err) {
      decisionError(res, err, 'DECISION_DISMISS_FAILED');
    }
  }));

  router.post('/:id/actions', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_action', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, userId);
    try {
      const result = await performDecisionAction(
        String(req.params.id || ''),
        String(req.body?.actionId || ''),
        userId,
        tenantId,
        {
          idempotencyKey: typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined,
          payload: typeof req.body?.payload === 'object' && req.body.payload ? req.body.payload : {},
        },
      );
      sendSuccess(res, result);
    } catch (err) {
      decisionError(res, err, 'INVALID_DECISION_ACTION');
    }
  }));

  return router;
}

export function deviceTokenRoutes(): Router {
  const router = Router();

  router.post('/', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'device_tokens_route_register')) return;
    const tenantId = routeTenantId(authReq, userId);
    try {
      const token = registerNotificationDeviceToken({
        userId,
        tenantId,
        token: String(req.body?.token || ''),
        environment: req.body?.environment === 'production' ? 'production' : 'sandbox',
        deviceId: typeof req.body?.deviceId === 'string' ? req.body.deviceId : authReq.deviceId,
        appVersion: typeof req.body?.appVersion === 'string' ? req.body.appVersion : null,
      });
      sendSuccess(res, {
        token: {
          tokenId: token.tokenId,
          platform: token.platform,
          environment: token.environment,
          tokenSuffix: token.tokenSuffix,
          deviceId: token.deviceId,
          lastSeenAt: token.lastSeenAt,
        },
      });
    } catch (err) {
      decisionError(res, err, 'INVALID_DEVICE_TOKEN');
    }
  }));

  router.delete('/:tokenId', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'device_tokens_route_revoke')) return;
    const tenantId = routeTenantId(authReq, userId);
    sendSuccess(res, { revoked: revokeNotificationDeviceToken(String(req.params.tokenId || ''), userId, tenantId) });
  }));

  return router;
}
