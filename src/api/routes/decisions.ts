// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { createHash } from 'node:crypto';
import type { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendSuccess } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import { secureSecretMatches } from '../secret-guards';
import {
  buildSkillDecisionFixtureIntent,
  applyDecisionTypeSuppression,
  createDecisionIntent,
  decisionRefreshSupportedForDecision,
  DecisionActionError,
  ensureDecisionCenterTables,
  evaluateDecisionApnsActionRequest,
  getDecisionOverview,
  getDecisionItem,
  getDecisionItemForCommand,
  getDecisionAuditHistory,
  getDecisionPreferences,
  getDecisionSummary,
  listDecisionTypeSuppressions,
  listHandledByNexusItems,
  listDecisionItems,
  isDecisionActionAttemptReplay,
  markDecisionViewed,
  refreshDecisionItem,
  recordDecisionItemExposuresByIds,
  performDecisionAction,
  reviewDecision,
  reviseDecisionProposal,
  suppressDecisionType,
  unsuppressDecisionType,
  updateDecisionPreferencesViaCommand,
  type DecisionTypeSuppressionMode,
  type DecisionUrgency,
  type DecisionReplacementChoice,
  type DecisionIntentCommandInput,
  DECISION_RANKING_VERSION,
} from '../../services/decision-center';
import {
  registerNotificationDeviceToken,
  revokeNotificationDeviceToken,
  type NotificationIntentType,
  type NotificationSourceSkill,
} from '../../services/notification-orchestrator';
import { assertTenantScope, requireMutationScope, TenantScopeError } from '../../services/tenant-scope';
import { buildDecisionCardSummary, resolveDecisionApiVersion } from '../decision-api-version';
import { paginateDecisions, sortDecisionsForKeyset } from '../decision-cursor';

const DECISION_REPLACEMENT_CHOICES = new Set<DecisionReplacementChoice>([
  'keep_existing_commitment',
  'replace_with_candidate',
  'choose_another_time',
  'review_tradeoff',
]);
import type { DecisionListResponse } from '../../services/decision-center';
import { invalidateNotificationInboxCaches } from '../../services/notification-cache-invalidation';
import { logger } from '../../utils/logger';
import { normalizeDecisionCenterError } from '../../services/decision-center/errors';
import {
  createDecisionMutationCommand,
  type DecisionMutationOperation,
} from '../../services/decision-center/contracts';
import { executeDecisionMutationWithReceipt } from '../../services/decision-center/command-receipts';
import { readDecisionRankSnapshotPageFromCurrentDatabase } from '../../services/decision-center/rank-snapshot-service';

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
  const normalized = normalizeDecisionCenterError(err);
  sendError(
    res,
    normalized.code === 'DECISION_INTERNAL_ERROR' ? fallbackCode : normalized.code,
    normalized.message,
    normalized.status,
    sanitizeDecisionErrorDetails(normalized.details),
  );
}

function mutationIdempotencyKey(
  body: Record<string, unknown>,
  actionId: string,
  decisionId: string,
  expectedVersion?: number,
): string | null {
  if (body.idempotencyKey != null) {
    if (typeof body.idempotencyKey !== 'string') return null;
    const explicit = body.idempotencyKey.trim();
    if (!explicit || explicit.length > 200) return null;
    return explicit;
  }
  // Additive compatibility for an old binary: bind its replay key to the
  // reviewed version and canonical request payload. New clients always send
  // their durable journal key.
  const payloadDigest = createHash('sha256').update(stableRouteJson(body)).digest('hex').slice(0, 24);
  return `legacy-rest:${actionId}:${decisionId}:v${expectedVersion ?? 'unversioned'}:${payloadDigest}`;
}

function stableRouteJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableRouteJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableRouteJson(record[key])}`).join(',')}}`;
}

function decisionProposalRequestFingerprint(
  body: Record<string, unknown>,
  userId: number,
  tenantId: number,
  fixtureSourceSkill?: string,
): string {
  const sanitized = { ...body };
  delete sanitized.idempotencyKey;
  delete sanitized.userId;
  delete sanitized.tenantId;
  return createHash('sha256').update(stableRouteJson({
    schemaVersion: 'decision-proposal-route@1.0.0',
    scope: { userId, tenantId },
    fixtureSourceSkill: fixtureSourceSkill ?? null,
    body: sanitized,
  })).digest('hex');
}

function executeRouteDecisionMutation<Result>(input: {
  operation: DecisionMutationOperation;
  resourceId: string;
  userId: number;
  tenantId: number;
  idempotencyKey: string;
  entityType: string;
  payload: Readonly<Record<string, unknown>>;
  mutate: () => Result;
}): { result: Result; idempotent: boolean } {
  ensureDecisionCenterTables();
  const requestedAt = new Date(Date.now()).toISOString();
  const commandKey = createHash('sha256').update(input.idempotencyKey).digest('hex');
  const command = createDecisionMutationCommand({
    commandId: `rest:${input.operation}:${commandKey}`,
    decisionId: input.resourceId,
    operation: input.operation,
    actionId: input.operation,
    scope: { userId: input.userId, tenantId: input.tenantId },
    channel: 'rest',
    idempotencyKey: input.idempotencyKey,
    recordVersion: null,
    contextVersion: null,
    approval: { requiredLevel: 'none', evidence: null },
    execution: {
      executorId: `decision-center.${input.operation}`,
      strategy: 'synchronous',
      riskLevel: 'low',
      reversible: true,
      supportsIdempotency: true,
    },
    readback: {
      verifierId: `decision-center.${input.operation}.readback`,
      entityType: input.entityType,
      entityId: input.resourceId,
      mode: 'exact',
      expectedState: {},
    },
    payload: input.payload,
    requestedAt,
  });
  return executeDecisionMutationWithReceipt(command, input.mutate);
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

/** Internal read cap for v2 cursor pagination when a rank snapshot is not yet available.
 *  It matches the snapshot repository and iOS traversal ceiling so fallback pagination
 *  cannot silently truncate the authoritative universe at an unrelated lower limit. */
const DECISION_LIST_CURSOR_CAP = 50_000;

export function decisionRoutes(): Router {
  const router = Router();

  router.get('/summary', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_summary')) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route');
    if (tenantId == null) return;
    const limit = positiveIntQuery(res, req.query.limit, 3, 'limit', 100);
    if (limit == null) return;
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
    const limit = positiveIntQuery(res, req.query.limit, 80, 'limit', 100);
    if (limit == null) return;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const sourceSkill = typeof req.query.sourceSkill === 'string' ? req.query.sourceSkill as NotificationSourceSkill : undefined;
    const type = typeof req.query.type === 'string' ? req.query.type as NotificationIntentType : undefined;
    const urgency = typeof req.query.urgency === 'string' ? req.query.urgency as DecisionUrgency : undefined;
    const { version, schemaVersion } = resolveDecisionApiVersion(authReq);
    // API v2 keyset cursor pagination — opt-in WITHIN v2 via ?cursor / ?pageSize. v1 and v2-without-cursor
    // responses are byte-identical to before (this branch only triggers on an explicit cursor/pageSize param).
    const cursorMode = version === 'v2' && (req.query.cursor !== undefined || req.query.pageSize !== undefined);
    if (cursorMode) {
      const pageSize = positiveIntQuery(res, req.query.pageSize, 50, 'pageSize', 100);
      if (pageSize == null) return;
      if (req.query.cursor !== undefined && typeof req.query.cursor !== 'string') {
        sendError(res, 'DECISION_CURSOR_MALFORMED', 'Decision cursor is malformed.', 400, { reason: 'encoding' });
        return;
      }
      let snapshotResolution: ReturnType<typeof readDecisionRankSnapshotPageFromCurrentDatabase>;
      try {
        snapshotResolution = readDecisionRankSnapshotPageFromCurrentDatabase({
          scope: { userId, tenantId },
          rankingVersion: DECISION_RANKING_VERSION,
          filters: { status, sourceSkill, type, urgency },
          cursorRaw: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
          pageSize,
        });
      } catch (err) {
        decisionError(res, err, 'DECISION_CURSOR_INVALID');
        return;
      }

      if (snapshotResolution.kind === 'snapshot') {
        const response: DecisionListResponse = {
          schemaVersion,
          count: snapshotResolution.cards.length,
          openCount: snapshotResolution.cards.filter((item) => ['unread', 'read', 'failed'].includes(item.status)).length,
          items: [...snapshotResolution.cards],
          pageSize,
          snapshotId: snapshotResolution.snapshotId,
          rankingAsOf: snapshotResolution.rankingAsOf,
          rankingVersion: snapshotResolution.rankingVersion,
          ...(snapshotResolution.nextCursor ? { nextCursor: snapshotResolution.nextCursor } : {}),
        };
        sendSuccess(res, response);
        return;
      }

      // Valid old cursors remain on their original ordering contract. A scope
      // awaiting migration backfill also falls back explicitly; the GET stays
      // pure and advertises structured degradation instead of creating state.
      const items = applyDecisionTypeSuppression(
        listDecisionItems(userId, tenantId, {
          status,
          sourceSkill,
          type,
          urgency,
          limit: DECISION_LIST_CURSOR_CAP,
          maxLimit: DECISION_LIST_CURSOR_CAP,
          recordExposure: false,
        }),
        userId,
        tenantId,
      );
      const cursor = snapshotResolution.kind === 'legacy'
        ? {
            priorityScore: snapshotResolution.cursor.priorityScore,
            createdAt: snapshotResolution.cursor.createdAt,
            decisionId: snapshotResolution.cursor.decisionId,
            rankingVersion: snapshotResolution.cursor.rankingVersion,
          }
        : null;
      let page: ReturnType<typeof paginateDecisions>['page'];
      let nextCursor: ReturnType<typeof paginateDecisions>['nextCursor'];
      try {
        ({ page, nextCursor } = paginateDecisions(sortDecisionsForKeyset(items), cursor, pageSize));
      } catch (err) {
        decisionError(res, err, 'DECISION_CURSOR_INVALID');
        return;
      }
      const response: DecisionListResponse = {
        schemaVersion,
        count: page.length,
        openCount: page.filter((item) => ['unread', 'read', 'failed'].includes(item.status)).length,
        items: page.map(buildDecisionCardSummary),
        pageSize,
        ...(nextCursor ? { nextCursor } : {}),
        ...(snapshotResolution.kind === 'unavailable' ? {
          degradationReasons: [{
            code: 'DECISION_RANK_SNAPSHOT_UNAVAILABLE',
            message: 'Immutable ranking snapshot is awaiting backfill.',
          }],
        } : {}),
      };
      sendSuccess(res, response);
      return;
    }
    // C3: drop user-suppressed types from the user-facing list (flag-gated; floored decisions never dropped).
    const items = applyDecisionTypeSuppression(
      listDecisionItems(userId, tenantId, {
        status,
        sourceSkill,
        type,
        urgency,
        limit,
        recordExposure: false,
      }),
      userId,
      tenantId,
    );
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey = mutationIdempotencyKey(
      body,
      'create_intent',
      typeof body.intentId === 'string' && body.intentId.trim() ? body.intentId.trim() : 'decision-intent',
    );
    if (!idempotencyKey) {
      sendError(res, 'VALIDATION', 'idempotencyKey must be a non-empty string of at most 200 characters', 400);
      return;
    }
    try {
      const result = await createDecisionIntent({
        ...body,
        userId,
        tenantId,
        idempotencyKey,
        channel: 'rest',
        proposalRequestFingerprint: decisionProposalRequestFingerprint(body, userId, tenantId),
      } as DecisionIntentCommandInput);
      if (result.item) invalidateNotificationInboxCaches(userId, tenantId);
      sendSuccess(res, result, { status: result.item ? 201 : 202 });
    } catch (err) {
      decisionError(res, err, 'INVALID_DECISION_INTENT');
    }
  }));

  // Explicit write-side exposure acknowledgement. List/detail GETs stay pure;
  // clients call this only for cards that actually became visible.
  router.post('/exposures', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_exposures')) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_exposures', 'decision_lifecycle_events');
    if (tenantId == null) return;
    const rawIds = req.body?.decisionIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 100
        || rawIds.some((id) => typeof id !== 'string' || id.trim().length === 0 || id.length > 200)) {
      sendError(res, 'VALIDATION', 'decisionIds must contain 1 to 100 non-empty decision IDs', 400);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey = mutationIdempotencyKey(body, 'record_exposure', 'decision-exposures');
    if (!idempotencyKey) {
      sendError(res, 'VALIDATION', 'idempotencyKey must be a non-empty string of at most 200 characters', 400);
      return;
    }
    try {
      const receipt = executeRouteDecisionMutation({
        operation: 'record_exposure',
        resourceId: 'decision-exposures',
        userId,
        tenantId,
        idempotencyKey,
        entityType: 'decision_exposure_batch',
        payload: { decisionIds: rawIds },
        mutate: () => recordDecisionItemExposuresByIds(rawIds, userId, tenantId),
      });
      sendSuccess(res, receipt.result);
    } catch (err) {
      decisionError(res, err, 'DECISION_EXPOSURE_FAILED');
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey = mutationIdempotencyKey(
      body,
      'create_fixture_intent',
      String(req.params.sourceSkill || 'secretary'),
    );
    if (!idempotencyKey) {
      sendError(res, 'VALIDATION', 'idempotencyKey must be a non-empty string of at most 200 characters', 400);
      return;
    }
    try {
      const fixture = buildSkillDecisionFixtureIntent(
        String(req.params.sourceSkill || 'secretary') as NotificationSourceSkill,
        userId,
        {
          ...body,
          tenantId,
          userId,
        },
      );
      const result = await createDecisionIntent({
        ...fixture,
        idempotencyKey,
        channel: 'rest',
        proposalRequestFingerprint: decisionProposalRequestFingerprint(
          body,
          userId,
          tenantId,
          String(req.params.sourceSkill || 'secretary'),
        ),
      });
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const idempotencyKey = mutationIdempotencyKey(body, 'update_preferences', 'decision-preferences');
    if (!idempotencyKey) {
      sendError(res, 'VALIDATION', 'idempotencyKey must be a non-empty string of at most 200 characters', 400);
      return;
    }
    const patch = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'idempotencyKey'));
    try {
      const receipt = updateDecisionPreferencesViaCommand({
        userId,
        tenantId,
        idempotencyKey,
        channel: 'rest',
        patch,
      });
      sendSuccess(res, receipt.preferences);
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
    const body = (req.body ?? {}) as Record<string, unknown>;
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
    const idempotencyKey = mutationIdempotencyKey(body, 'suppress_type', `${sourceSkill}:${type}:${recipe ?? '*'}`);
    if (!idempotencyKey) {
      sendError(res, 'VALIDATION', 'idempotencyKey must be a non-empty string of at most 200 characters', 400);
      return;
    }
    try {
      const receipt = executeRouteDecisionMutation({
        operation: 'suppress_type',
        resourceId: `decision-suppression:${sourceSkill}:${type}:${recipe ?? '*'}`,
        userId,
        tenantId,
        idempotencyKey,
        entityType: 'decision_type_suppression',
        payload: {
          sourceSkill,
          type,
          mode,
          untilDays: body.untilDays ?? null,
          recipe,
        },
        mutate: () => {
          suppressDecisionType(userId, tenantId, sourceSkill, type, mode as DecisionTypeSuppressionMode, until, recipe);
          return { suppressions: listDecisionTypeSuppressions(userId, tenantId) };
        },
      });
      sendSuccess(res, receipt.result, { status: 201 });
    } catch (err) {
      // Map service-layer DecisionActionError (VALIDATION / INVALID_SCOPE) to its intended 4xx instead of a
      // 500, consistent with every other handler in this file.
      decisionError(res, err, 'DECISION_SUPPRESS_FAILED');
      return;
    }
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const receiptPayload = { sourceSkill, type, recipe };
    const idempotencyKey = mutationIdempotencyKey(
      { ...receiptPayload, ...body },
      'unsuppress_type',
      `${sourceSkill}:${type}:${recipe ?? '*'}`,
    );
    if (!idempotencyKey) {
      sendError(res, 'VALIDATION', 'idempotencyKey must be a non-empty string of at most 200 characters', 400);
      return;
    }
    try {
      const receipt = executeRouteDecisionMutation({
        operation: 'unsuppress_type',
        resourceId: `decision-suppression:${sourceSkill}:${type}:${recipe ?? '*'}`,
        userId,
        tenantId,
        idempotencyKey,
        entityType: 'decision_type_suppression',
        payload: receiptPayload,
        mutate: () => {
          unsuppressDecisionType(userId, tenantId, sourceSkill, type, recipe);
          return { suppressions: listDecisionTypeSuppressions(userId, tenantId) };
        },
      });
      sendSuccess(res, receipt.result);
    } catch (err) {
      decisionError(res, err, 'DECISION_UNSUPPRESS_FAILED');
      return;
    }
  }));

  router.get('/handled', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_handled')) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route');
    if (tenantId == null) return;
    const limit = positiveIntQuery(res, req.query.limit, 25, 'limit', 100);
    if (limit == null) return;
    const items = listHandledByNexusItems(userId, tenantId, limit);
    sendSuccess(res, { count: items.length, items });
  }));

  router.get('/:id', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_detail', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route');
    if (tenantId == null) return;
    // Exact detail is also the canonical mutation readback. Preserve terminal
    // owned rows here so durable clients can reconcile a completed write even
    // after the item correctly disappears from active list projections.
    const item = getDecisionItemForCommand(String(req.params.id || ''), userId, tenantId);
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const expectedVersion = body.expectedVersion ?? body.recordVersion;
    if (expectedVersion != null && (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) <= 0)) {
      sendError(res, 'VALIDATION', 'expectedVersion must be a positive integer', 400);
      return;
    }
    const decisionId = String(req.params.id || '');
    const idempotencyKey = mutationIdempotencyKey(
      body,
      'mark_viewed',
      decisionId,
      typeof expectedVersion === 'number' ? expectedVersion : undefined,
    );
    if (!idempotencyKey) {
      sendError(res, 'VALIDATION', 'idempotencyKey must be a non-empty string of at most 200 characters', 400);
      return;
    }
    try {
      const item = markDecisionViewed(decisionId, userId, tenantId, {
        idempotencyKey,
        expectedVersion: typeof expectedVersion === 'number' ? expectedVersion : undefined,
        channel: 'rest',
      });
      invalidateNotificationInboxCaches(userId, tenantId);
      sendSuccess(res, { item });
    } catch (err) {
      decisionError(res, err, 'DECISION_VIEW_FAILED');
    }
  }));

  // Refresh-evidence: token-zero revalidation against current local authoritative state. This explicit
  // POST may persist a new context evaluation and increment recordVersion when enforcement is active.
  // Flag-gated (DECISION_REFRESH_ENABLED, default OFF -> 404). Respects v2 card negotiation.
  router.post('/:id/refresh', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_refresh', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_refresh', 'notification_center_items');
    if (tenantId == null) return;
    if (!decisionRefreshSupportedForDecision(String(req.params.id || ''), userId, tenantId)) {
      sendError(res, 'NOT_FOUND', 'Decision refresh is not enabled', 404);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decisionId = String(req.params.id || '');
    const current = getDecisionItem(decisionId, userId, tenantId);
    if (!current) {
      sendError(res, 'DECISION_NOT_FOUND', 'Decision not found', 404);
      return;
    }
    const expectedVersion = body.expectedVersion ?? body.recordVersion ?? current.recordVersion;
    if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) <= 0) {
      sendError(res, 'VALIDATION', 'expectedVersion must be a positive integer', 400);
      return;
    }
    if (body.contextVersion != null && (typeof body.contextVersion !== 'string' || !body.contextVersion.trim())) {
      sendError(res, 'VALIDATION', 'contextVersion must be a non-empty string', 400);
      return;
    }
    const contextVersion = typeof body.contextVersion === 'string'
      ? body.contextVersion
      : current.contextVersion;
    const idempotencyKey = mutationIdempotencyKey(
      body,
      'refresh',
      decisionId,
      Number(expectedVersion),
    );
    if (!idempotencyKey) {
      sendError(res, 'VALIDATION', 'idempotencyKey must be a non-empty string of at most 200 characters', 400);
      return;
    }
    try {
      const result = refreshDecisionItem(decisionId, userId, tenantId, {
        idempotencyKey,
        expectedVersion: Number(expectedVersion),
        ...(contextVersion ? { contextVersion } : {}),
        channel: 'rest',
      });
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
    } catch (err) {
      decisionError(res, err, 'DECISION_REFRESH_FAILED');
    }
  }));

  router.get('/:id/history', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_history', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_history');
    if (tenantId == null) return;
    const decisionId = String(req.params.id || '');
    try {
      sendSuccess(res, { decisionId, ...getDecisionAuditHistory(decisionId, userId, tenantId) });
    } catch (err) {
      decisionError(res, err, 'DECISION_HISTORY_FAILED');
    }
  }));

  router.post('/:id/review', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_review', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_review', 'notification_center_items');
    if (tenantId == null) return;
    const outcome = req.body?.outcome;
    if (outcome !== 'approve' && outcome !== 'reject' && outcome !== 'defer') {
      sendError(res, 'VALIDATION', 'outcome must be approve, reject, or defer', 400);
      return;
    }
    const expectedVersion = req.body?.expectedVersion ?? req.body?.recordVersion;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
      sendError(res, 'VALIDATION', 'expectedVersion must be a positive integer', 400);
      return;
    }
    const replacementChoiceId = typeof req.body?.replacementChoiceId === 'string'
      && DECISION_REPLACEMENT_CHOICES.has(req.body.replacementChoiceId as DecisionReplacementChoice)
      ? req.body.replacementChoiceId as DecisionReplacementChoice
      : undefined;
    if (req.body?.replacementChoiceId != null && !replacementChoiceId) {
      sendError(res, 'VALIDATION', 'replacementChoiceId is not a supported conflict option', 400);
      return;
    }
    const idempotencyKey = mutationIdempotencyKey(
      req.body ?? {},
      `review:${outcome}`,
      String(req.params.id || ''),
      expectedVersion,
    );
    if (!idempotencyKey) {
      sendError(res, 'VALIDATION', 'idempotencyKey must be a non-empty string of at most 200 characters', 400);
      return;
    }
    try {
      const item = reviewDecision(String(req.params.id || ''), userId, tenantId, {
        outcome,
        expectedVersion,
        idempotencyKey,
        deferUntil: typeof req.body?.deferUntil === 'string' ? req.body.deferUntil : undefined,
        reasonCode: typeof req.body?.reasonCode === 'string' ? req.body.reasonCode : undefined,
        replacementChoiceId,
        channel: 'rest',
        strongConfirmationText: typeof req.body?.strongConfirmationText === 'string'
          ? req.body.strongConfirmationText
          : undefined,
      });
      invalidateNotificationInboxCaches(userId, tenantId);
      sendSuccess(res, { item });
    } catch (err) {
      decisionError(res, err, 'DECISION_REVIEW_FAILED');
    }
  }));

  router.patch('/:id/proposal', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_revise', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_revise', 'notification_center_items');
    if (tenantId == null) return;
    const expectedVersion = req.body?.expectedVersion ?? req.body?.recordVersion;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
      sendError(res, 'VALIDATION', 'expectedVersion must be a positive integer', 400);
      return;
    }
    const idempotencyKey = mutationIdempotencyKey(
      req.body ?? {},
      'edit_proposal',
      String(req.params.id || ''),
      expectedVersion,
    );
    if (!idempotencyKey) {
      sendError(res, 'VALIDATION', 'idempotencyKey must be a non-empty string of at most 200 characters', 400);
      return;
    }
    try {
      const item = reviseDecisionProposal(String(req.params.id || ''), userId, tenantId, {
        expectedVersion,
        idempotencyKey,
        channel: 'rest',
        recommendedStartAt: typeof req.body?.recommendedStartAt === 'string' ? req.body.recommendedStartAt : undefined,
        recommendedEndAt: typeof req.body?.recommendedEndAt === 'string' ? req.body.recommendedEndAt : undefined,
      });
      invalidateNotificationInboxCaches(userId, tenantId);
      sendSuccess(res, { item });
    } catch (err) {
      decisionError(res, err, 'DECISION_PROPOSAL_EDIT_FAILED');
    }
  }));

  router.patch('/:id/snooze', asyncHandler(async (req, res: Response) => {
    const authReq = req as unknown as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res, userId, 'decisions_route_snooze', { decisionId: req.params.id })) return;
    const tenantId = routeTenantId(authReq, res, userId, 'decisions_route_snooze', 'notification_center_items');
    if (tenantId == null) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decisionId = String(req.params.id || '');
    const expectedVersion = body.expectedVersion;
    if (expectedVersion != null && (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) <= 0)) {
      sendError(res, 'VALIDATION', 'expectedVersion must be a positive integer', 400);
      return;
    }
    if (body.minutes != null && (!Number.isSafeInteger(body.minutes) || Number(body.minutes) <= 0)) {
      sendError(res, 'VALIDATION', 'minutes must be a positive integer', 400);
      return;
    }
    if (body.deferUntil != null && typeof body.deferUntil !== 'string') {
      sendError(res, 'VALIDATION', 'deferUntil must be an ISO timestamp', 400);
      return;
    }
    const idempotencyKey = mutationIdempotencyKey(
      body,
      'snooze',
      decisionId,
      typeof expectedVersion === 'number' ? expectedVersion : undefined,
    );
    if (!idempotencyKey) {
      sendError(res, 'VALIDATION', 'idempotencyKey must be a non-empty string of at most 200 characters', 400);
      return;
    }
    try {
      const result = await performDecisionAction(decisionId, 'snooze', userId, tenantId, {
        idempotencyKey,
        expectedVersion: typeof expectedVersion === 'number' ? expectedVersion : undefined,
        contextVersion: typeof body.contextVersion === 'string' ? body.contextVersion : undefined,
        channel: 'rest',
        payload: {
          ...(body.minutes == null ? {} : { minutes: body.minutes }),
          ...(typeof body.deferUntil === 'string' ? { deferUntil: body.deferUntil } : {}),
          ...(typeof body.followUp === 'string' ? { followUp: body.followUp } : {}),
        },
      });
      invalidateNotificationInboxCaches(userId, tenantId);
      sendSuccess(res, { item: result.item });
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decisionId = String(req.params.id || '');
    const expectedVersion = body.expectedVersion;
    if (expectedVersion != null && (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) <= 0)) {
      sendError(res, 'VALIDATION', 'expectedVersion must be a positive integer', 400);
      return;
    }
    const idempotencyKey = mutationIdempotencyKey(
      body,
      'dismiss',
      decisionId,
      typeof expectedVersion === 'number' ? expectedVersion : undefined,
    );
    if (!idempotencyKey) {
      sendError(res, 'VALIDATION', 'idempotencyKey must be a non-empty string of at most 200 characters', 400);
      return;
    }
    try {
      const result = await performDecisionAction(decisionId, 'dismiss', userId, tenantId, {
        idempotencyKey,
        expectedVersion: typeof expectedVersion === 'number' ? expectedVersion : undefined,
        contextVersion: typeof body.contextVersion === 'string' ? body.contextVersion : undefined,
        channel: 'rest',
        payload: typeof body.reason === 'string' ? { reason: body.reason } : {},
      });
      invalidateNotificationInboxCaches(userId, tenantId);
      sendSuccess(res, { item: result.item });
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decisionId = String(req.params.id || '');
    const actionId = String(body.actionId || '');
    const expectedVersion = body.expectedVersion ?? body.recordVersion;
    if (expectedVersion != null && (
      typeof expectedVersion !== 'number'
      || !Number.isSafeInteger(expectedVersion)
      || expectedVersion <= 0
    )) {
      sendError(res, 'VALIDATION', 'expectedVersion must be a positive integer', 400);
      return;
    }
    const idempotencyKey = mutationIdempotencyKey(
      body,
      actionId,
      decisionId,
      typeof expectedVersion === 'number' ? expectedVersion : undefined,
    );
    if (!idempotencyKey) {
      sendError(res, 'VALIDATION', 'idempotencyKey must be a non-empty string of at most 200 characters', 400);
      return;
    }
    try {
      const channel = typeof body.channel === 'string' ? body.channel : undefined;
      const isApnsReplay = channel === 'apns' && isDecisionActionAttemptReplay({
        decisionId,
        actionId,
        userId,
        tenantId,
        idempotencyKey,
      });
      if (channel === 'apns' && !isApnsReplay) {
        const policy = evaluateDecisionApnsActionRequest({
          decisionId,
          actionId,
          userId,
          tenantId,
          recordVersion: typeof expectedVersion === 'number' ? expectedVersion : null,
          contextVersion: typeof body.contextVersion === 'string' ? body.contextVersion : null,
        });
        if (!policy.execute) {
          sendSuccess(res, policy);
          return;
        }
      }
      const result = await performDecisionAction(
        decisionId,
        actionId,
        userId,
        tenantId,
        {
          idempotencyKey,
          payload: typeof body.payload === 'object' && body.payload ? body.payload as Record<string, unknown> : {},
          channel,
          expectedVersion: typeof expectedVersion === 'number' ? expectedVersion : undefined,
          contextVersion: typeof body.contextVersion === 'string' ? body.contextVersion : undefined,
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
        // JWT-bound device identity prevents a body value from revoking or
        // re-associating another user's push registration.
        deviceId: authReq.deviceId,
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
