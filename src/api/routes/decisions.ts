// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendSuccess } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import { secureSecretMatches } from '../secret-guards';
import {
  buildSkillDecisionFixtureIntent,
  applyDecisionTypeSuppression,
  createDecisionIntent,
  DecisionActionError,
  dismissDecision,
  getDecisionOverview,
  getDecisionItem,
  getDecisionPreferences,
  getDecisionSummary,
  listDecisionTypeSuppressions,
  listHandledByNexusItems,
  listDecisionItems,
  recordDecisionItemExposures,
  markDecisionViewed,
  refreshDecisionItem,
  performDecisionAction,
  snoozeDecision,
  suppressDecisionType,
  unsuppressDecisionType,
  updateDecisionPreferences,
  type DecisionTypeSuppressionMode,
  type DecisionUrgency,
} from '../../services/decision-center';
import {
  registerNotificationDeviceToken,
  revokeNotificationDeviceToken,
  type NotificationIntentType,
  type NotificationSourceSkill,
} from '../../services/notification-orchestrator';
import { assertTenantScope, requireMutationScope, TenantScopeError } from '../../services/tenant-scope';
import { buildDecisionCardSummary, resolveDecisionApiVersion } from '../decision-api-version';
import { decodeDecisionCursor, paginateDecisions, sortDecisionsForKeyset } from '../decision-cursor';
import type { DecisionListResponse } from '../../services/decision-center';
import { isDecisionRefreshEnabled } from '../../services/runtime-flags';
import { invalidateNotificationInboxCaches } from '../../services/notification-cache-invalidation';
import { logger } from '../../utils/logger';

function routeTenantId(
  req: AuthenticatedRequest,
  res: Response,
  userId: number,
  operation: string,
  mutationTable?: string,
): number | null {
  try {
    const scope = mutationTable
      ? requireMutationScope(req, mutationTable, operation)
      : assertTenantScope(req, operation);
    if (scope.userId === userId) return scope.tenantId;
    logger.warn({ userId, scopedUserId: scope.userId, operation }, 'Decision route rejected mismatched authenticated user scope');
    sendError(res, 'UNAUTHORIZED', 'Invalid authenticated user scope', 401);
  } catch (err) {
    if (err instanceof TenantScopeError) {
      sendError(res, err.code, err.message, err.status);
      return null;
    }
    throw err;
  }
  return null;
}

function isInternalDecisionIntentRequest(req: AuthenticatedRequest): boolean {
  const expected = process.env.INTERNAL_API_SECRET || '';
  const provided = req.header('x-internal-secret');
  return Boolean(expected) && secureSecretMatches(expected, provided);
}

function sanitizeDecisionErrorDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === 'originalMessage') continue;
    if (Array.isArray(value)) {
      sanitized[key] = value.map((entry) => (
        entry && typeof entry === 'object' ? sanitizeDecisionErrorDetails(entry as Record<string, unknown>) : entry
      ));
      continue;
    }
    sanitized[key] = value && typeof value === 'object'
      ? sanitizeDecisionErrorDetails(value as Record<string, unknown>)
      : value;
  }
  return sanitized;
}

function decisionError(res: Response, err: unknown, fallbackCode = 'DECISION_ERROR'): void {
  if (err instanceof DecisionActionError) {
    sendError(res, err.code, err.message, err.status, sanitizeDecisionErrorDetails(err.details));
    return;
  }
  logger.warn({ err }, 'Decision route rejected request');
  sendError(res, fallbackCode, 'Unable to process decision request', 400);
}

function positiveIntQuery(res: Response, raw: unknown, fallback: number, name: string, max: number): number | null {
  if (raw == null || raw === '') return fallback;
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    sendError(res, 'VALIDATION', `${name} must be a positive integer`, 400, { [name]: raw });
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    sendError(res, 'VALIDATION', `${name} must be a positive integer`, 400, { [name]: raw });
    return null;
  }
  return Math.min(parsed, max);
}

/** Internal read cap for v2 cursor pagination: the full active list to paginate over (cursor/pageSize bound
 *  the page). Comfortably exceeds the ~50-active-per-user product ceiling so cursors traverse everything. */
const DECISION_LIST_CURSOR_CAP = 500;

export function decisionRoutes(): Router {
  const router = Router();

  router.get('/summary', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_summary')) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route');
    if (tenantId == null) return;
    const limit = parseInt(String(req.query.limit || '3'), 10);
    const summary = getDecisionSummary(userId, tenantId, limit);
    const { version, schemaVersion } = resolveDecisionApiVersion(authReq);
    sendSuccess(res, version === 'v2'
      ? { ...summary, schemaVersion, previewItems: summary.previewItems.map(buildDecisionCardSummary) }
      : summary);
  }));

  router.get('/overview', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_overview')) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route');
    if (tenantId == null) return;
    const limit = positiveIntQuery(res, req.query.limit, 80, 'limit', 100);
    if (limit == null) return;
    const handledLimit = positiveIntQuery(res, req.query.handledLimit, 10, 'handledLimit', 25);
    if (handledLimit == null) return;
    // BE-1 (Content Studio): optional skill-scoped overview. Absent param =>
    // byte-identical response to before.
    const sourceSkill = typeof req.query.sourceSkill === 'string' && req.query.sourceSkill.trim() !== ''
      ? req.query.sourceSkill as NotificationSourceSkill
      : undefined;
    const overview = getDecisionOverview(userId, tenantId, { limit, handledLimit, sourceSkill });
    const { version, schemaVersion } = resolveDecisionApiVersion(authReq);
    sendSuccess(res, version === 'v2'
      ? {
          ...overview,
          schemaVersion,
          items: overview.items.map(buildDecisionCardSummary),
          summary: { ...overview.summary, previewItems: overview.summary.previewItems.map(buildDecisionCardSummary) },
        }
      : overview);
  }));

  router.get('/', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_list')) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route');
    if (tenantId == null) return;
    const limit = parseInt(String(req.query.limit || '80'), 10);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const sourceSkill = typeof req.query.sourceSkill === 'string' ? req.query.sourceSkill as NotificationSourceSkill : undefined;
    const type = typeof req.query.type === 'string' ? req.query.type as NotificationIntentType : undefined;
    const urgency = typeof req.query.urgency === 'string' ? req.query.urgency as DecisionUrgency : undefined;
    const { version, schemaVersion } = resolveDecisionApiVersion(authReq);
    // API v2 keyset cursor pagination — opt-in WITHIN v2 via ?cursor / ?pageSize. v1 and v2-without-cursor
    // responses are byte-identical to before (this branch only triggers on an explicit cursor/pageSize param).
    const cursorMode = version === 'v2' && (req.query.cursor !== undefined || req.query.pageSize !== undefined);
    // In cursor mode the URL ?limit is irrelevant — the pagination universe must be the FULL active list, so
    // read with a generous internal cap (cursor/pageSize bound the page). Otherwise a >80-item user would get
    // nextCursor=null mid-dataset. The cap comfortably exceeds the ~50-active-per-user product ceiling.
    const readLimit = cursorMode ? DECISION_LIST_CURSOR_CAP : limit;
    // C3: drop user-suppressed types from the user-facing list (flag-gated; floored decisions never dropped).
    const items = applyDecisionTypeSuppression(
      listDecisionItems(userId, tenantId, {
        status,
        sourceSkill,
        type,
        urgency,
        limit: readLimit,
        recordExposure: false,
        ...(cursorMode ? { maxLimit: DECISION_LIST_CURSOR_CAP } : {}),
      }),
      userId,
      tenantId,
    );
    if (cursorMode) {
      const pageSize = positiveIntQuery(res, req.query.pageSize, 50, 'pageSize', 100);
      if (pageSize == null) return;
      const cursor = typeof req.query.cursor === 'string' ? decodeDecisionCursor(req.query.cursor) : null;
      const { page, nextCursor } = paginateDecisions(sortDecisionsForKeyset(items), cursor, pageSize);
      recordDecisionItemExposures(page);
      const response: DecisionListResponse = {
        schemaVersion,
        count: page.length,
        openCount: page.filter((item) => ['unread', 'read', 'failed'].includes(item.status)).length,
        items: page.map(buildDecisionCardSummary),
        pageSize,
        ...(nextCursor ? { nextCursor } : {}),
      };
      sendSuccess(res, response);
      return;
    }
    recordDecisionItemExposures(items);
    const response = {
      count: items.length,
      openCount: items.filter((item) => ['unread', 'read', 'failed'].includes(item.status)).length,
      items: version === 'v2' ? items.map(buildDecisionCardSummary) : items,
    };
    sendSuccess(res, version === 'v2' ? { schemaVersion, ...response } : response);
  }));

  router.post('/intents', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_create_intent')) return;
    if (!isInternalDecisionIntentRequest(authReq)) {
      sendError(res, 'FORBIDDEN', 'Decision intents are internal service events', 403);
      return;
    }
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_create_intent', 'notification_center_items');
    if (tenantId == null) return;
    try {
      const result = await createDecisionIntent({
        ...(req.body ?? {}),
        userId,
        tenantId,
      });
      if (result.item) invalidateNotificationInboxCaches(userId, tenantId);
      sendSuccess(res, result, { status: result.item ? 201 : 202 });
    } catch (err) {
      decisionError(res, err, 'INVALID_DECISION_INTENT');
    }
  }));

  router.post('/intents/fixtures/:sourceSkill', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_fixture_intent')) return;
    if (!isInternalDecisionIntentRequest(authReq)) {
      sendError(res, 'FORBIDDEN', 'Decision fixtures are internal service events', 403);
      return;
    }
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_fixture_intent', 'notification_center_items');
    if (tenantId == null) return;
    try {
      const result = await createDecisionIntent(buildSkillDecisionFixtureIntent(
        String(req.params.sourceSkill || 'secretary') as NotificationSourceSkill,
        userId,
        {
          ...(req.body ?? {}),
          tenantId,
          userId,
        },
      ));
      if (result.item) invalidateNotificationInboxCaches(userId, tenantId);
      sendSuccess(res, result, { status: result.item ? 201 : 202 });
    } catch (err) {
      decisionError(res, err, 'INVALID_DECISION_FIXTURE');
    }
  }));

  router.get('/preferences', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_get_preferences')) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route');
    if (tenantId == null) return;
    sendSuccess(res, getDecisionPreferences(userId, tenantId));
  }));

  router.put('/preferences', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_update_preferences')) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_update_preferences', 'notification_profiles');
    if (tenantId == null) return;
    try {
      sendSuccess(res, updateDecisionPreferences(userId, tenantId, req.body ?? {}));
    } catch (err) {
      decisionError(res, err, 'INVALID_DECISION_PREFERENCES');
    }
  }));

  // C3 type-suppression controls. The READ FILTER is flag-gated (DECISION_TYPE_SUPPRESSION_ENABLED); these
  // write/read endpoints persist the preference regardless so it is ready when the flag flips.
  router.get('/preferences/suppressions', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_list_suppressions')) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route');
    if (tenantId == null) return;
    sendSuccess(res, { suppressions: listDecisionTypeSuppressions(userId, tenantId) });
  }));

  router.post('/preferences/suppress-type', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_suppress_type')) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_suppress_type', 'decision_type_suppressions');
    if (tenantId == null) return;
    const body = (req.body ?? {}) as { sourceSkill?: unknown; type?: unknown; mode?: unknown; untilDays?: unknown; recipe?: unknown };
    const sourceSkill = typeof body.sourceSkill === 'string' ? body.sourceSkill.trim() : '';
    const type = typeof body.type === 'string' ? body.type.trim() : '';
    const recipe = typeof body.recipe === 'string' && body.recipe.trim() ? body.recipe.trim() : null;
    const mode = body.mode === 'snooze_type' ? 'snooze_type' : body.mode === 'dont_show_type' ? 'dont_show_type' : null;
    if (!sourceSkill || !type || !mode) {
      sendError(res, 'VALIDATION', 'sourceSkill, type, and mode (dont_show_type|snooze_type) are required', 400);
      return;
    }
    let until: string | null = null;
    if (mode === 'snooze_type') {
      const days = positiveIntQuery(res, body.untilDays ?? 7, 7, 'untilDays', 365);
      if (days == null) return;
      until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }
    try {
      suppressDecisionType(userId, tenantId, sourceSkill, type, mode as DecisionTypeSuppressionMode, until, recipe);
    } catch (err) {
      // Map service-layer DecisionActionError (VALIDATION / INVALID_SCOPE) to its intended 4xx instead of a
      // 500, consistent with every other handler in this file.
      decisionError(res, err, 'DECISION_SUPPRESS_FAILED');
      return;
    }
    sendSuccess(res, { suppressions: listDecisionTypeSuppressions(userId, tenantId) }, { status: 201 });
  }));

  router.delete('/preferences/suppress-type', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_unsuppress_type')) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_unsuppress_type', 'decision_type_suppressions');
    if (tenantId == null) return;
    const sourceSkill = typeof req.query.sourceSkill === 'string' ? req.query.sourceSkill.trim() : '';
    const type = typeof req.query.type === 'string' ? req.query.type.trim() : '';
    const recipe = typeof req.query.recipe === 'string' && req.query.recipe.trim() ? req.query.recipe.trim() : null;
    if (!sourceSkill || !type) {
      sendError(res, 'VALIDATION', 'sourceSkill and type query params are required', 400);
      return;
    }
    try {
      unsuppressDecisionType(userId, tenantId, sourceSkill, type, recipe);
    } catch (err) {
      decisionError(res, err, 'DECISION_UNSUPPRESS_FAILED');
      return;
    }
    sendSuccess(res, { suppressions: listDecisionTypeSuppressions(userId, tenantId) });
  }));

  router.get('/handled', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_handled')) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route');
    if (tenantId == null) return;
    const limit = parseInt(String(req.query.limit || '25'), 10);
    const items = listHandledByNexusItems(userId, tenantId, limit);
    sendSuccess(res, { count: items.length, items });
  }));

  router.get('/:id', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_detail', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route');
    if (tenantId == null) return;
    const item = getDecisionItem(String(req.params.id || ''), userId, tenantId);
    if (!item) {
      sendError(res, 'NOT_FOUND', 'Decision not found', 404);
      return;
    }
    const { version, schemaVersion } = resolveDecisionApiVersion(authReq);
    sendSuccess(res, version === 'v2' ? { schemaVersion, item } : { item });
  }));

  router.patch('/:id/viewed', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_viewed', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_viewed', 'notification_center_items');
    if (tenantId == null) return;
    try {
      const item = markDecisionViewed(String(req.params.id || ''), userId, tenantId);
      invalidateNotificationInboxCaches(userId, tenantId);
      sendSuccess(res, { item });
    } catch (err) {
      decisionError(res, err, 'DECISION_VIEW_FAILED');
    }
  }));

  // Refresh-evidence: re-derive a decision's computed fields from current stored state (token-zero, read-only).
  // Flag-gated (DECISION_REFRESH_ENABLED, default OFF -> 404). Respects v2 card negotiation.
  router.post('/:id/refresh', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_refresh', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_refresh');
    if (tenantId == null) return;
    if (!isDecisionRefreshEnabled(process.env, { userId, tenantId })) {
      sendError(res, 'NOT_FOUND', 'Decision refresh is not enabled', 404);
      return;
    }
    const result = refreshDecisionItem(String(req.params.id || ''), userId, tenantId);
    if (!result) {
      sendError(res, 'DECISION_NOT_FOUND', 'Decision not found', 404);
      return;
    }
    const { version, schemaVersion } = resolveDecisionApiVersion(authReq);
    sendSuccess(res, {
      schemaVersion,
      item: version === 'v2' ? buildDecisionCardSummary(result.item) : result.item,
      refreshedAt: result.refreshedAt,
    });
  }));

  router.patch('/:id/snooze', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_snooze', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_snooze', 'notification_center_items');
    if (tenantId == null) return;
    try {
      const item = snoozeDecision(String(req.params.id || ''), userId, tenantId, Number(req.body?.minutes ?? 60));
      invalidateNotificationInboxCaches(userId, tenantId);
      sendSuccess(res, { item });
    } catch (err) {
      decisionError(res, err, 'DECISION_SNOOZE_FAILED');
    }
  }));

  router.patch('/:id/dismiss', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_dismiss', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_dismiss', 'notification_center_items');
    if (tenantId == null) return;
    try {
      const item = dismissDecision(String(req.params.id || ''), userId, tenantId, typeof req.body?.reason === 'string' ? req.body.reason : undefined);
      invalidateNotificationInboxCaches(userId, tenantId);
      sendSuccess(res, { item });
    } catch (err) {
      decisionError(res, err, 'DECISION_DISMISS_FAILED');
    }
  }));

  router.post('/:id/actions', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_action', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_action', 'notification_center_items');
    if (tenantId == null) return;
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
      invalidateNotificationInboxCaches(userId, tenantId);
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
    const tenantId = routeTenantId(authReq, res, userId, 'device_tokens_route_register', 'notification_device_tokens');
    if (tenantId == null) return;
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
    const tenantId = routeTenantId(authReq, res, userId, 'device_tokens_route_revoke', 'notification_device_tokens');
    if (tenantId == null) return;
    sendSuccess(res, { revoked: revokeNotificationDeviceToken(String(req.params.tokenId || ''), userId, tenantId) });
  }));

  return router;
}
