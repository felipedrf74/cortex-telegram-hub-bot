// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * POST /api/v1/chat routes: /message (stage pipeline), /confirm-action, and
 * the pending-action prefill read.
 *
 * M10: the former ~25-checkpoint monolithic /message handler now lives in
 * src/api/routes/chat-pipeline/ as an ordered stage array (see runner.ts).
 * This file keeps route registration, per-request context assembly, the
 * runner invocation, and the deterministic /confirm-action endpoint. The
 * replay corpus (__tests__/api/chat-message-replay.test.ts) pins envelopes
 * byte-for-byte plus the stage-trace order.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { pushEvent } from '../../portal/telemetry';
import { getUserById, getUserLanguageById, getUserTimezoneById } from '../../services/user-service';
import { acquireAiBudgetReservation } from '../../services/cost-guardrail';
import { getCurrentRequestId } from '../../utils/request-context';
import { executeConfirmedChatActionRuns } from '../../services/chat';
import { getPendingChatActionById } from '../../services/chat-action-state';
import {
  clearPendingChatConfirmation,
  getCompletedChatConfirmation,
  getPendingChatConfirmation,
  rememberCompletedChatConfirmation,
} from '../../services/chat-pending-confirmations';
import { validateChatConfirmationToken } from '../../services/chat-confirmation-token';
import { asyncHandler, sendAiBudgetError, sendInternalError } from '../response-helpers';
import {
  claimPendingChatCoreV2Command,
  clearPendingChatCoreV2Command,
  executeChatCoreV2Command,
  type ChatCoreV2CommandExecutionResult,
} from '../../services/chat-core-v2';
import {
  findDecisionByRelatedEntity,
  performDecisionAction,
} from '../../services/decision-center';
import { createChatLatencyTracker } from '../../services/chat-answer-contract';
import {
  normalizeChatMessageRequest,
  persistChatLanguagePreference,
} from './chat-message-request';
import { sendRetryableChatFailureResponseIfNeeded } from './chat-message-degraded-response';
import { buildChatCoreV2CommandConfirmationShortcutResponse } from './chat-core-v2-command-confirmation-response';
import { isPendingChatWorkCancellationTurn } from '../../services/chat-pending-cancellation';
// M6 stage-trace seam: no-op unless CHAT_STAGE_TRACE / the test seam is on.
// The route records request_received; every other checkpoint family records
// its stage inside its chat-pipeline stage module.
import { recordChatStage } from '../../services/chat-stage-trace';
import { runChatMessagePipeline } from './chat-pipeline/runner';
import { isLoopbackRequest } from '../secret-guards';
import {
  ChatLiveEvalContractError,
  hasChatLiveEvalHeaders,
  resolveChatLiveEvalRequest,
} from '../../services/chat-live-evaluation-contract';
import { runWithChatLiveEvalContext } from '../../services/chat-live-evaluation-context';
import {
  buildChatCoreV2GuardOnlyConfirmationLabels,
  buildChatCoreV2GuardOnlyConfirmationText,
  buildUserMessageId,
  isChatCoreV2GuardOnlyPendingConfirmation,
  newAssistantMessageId,
  normalizeIdempotencyKey,
  resolveChatCoreV2RouteLocale,
  statusForChatActionResponse,
  withIdempotentConfirmationReplay,
} from './chat-pipeline/support';
import {
  recordConfirmedChatActionWriteEvidence,
  recordConfirmedChatCoreV2CommandWriteEvidence,
} from './chat-pipeline/write-evidence';

type ChatRouteScopeGuard = (
  res: Response,
  userId: number | undefined,
  tenantId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

export { clearChatActiveDomain } from './chat-message-context';

// M8: the metadata/contract enrichment helpers moved to
// ./chat-message-finalizer — the single terminal pipeline for every
// /message response family (finalizeChatMessageResponse /
// finalizeChatAnswerMetadata, policy table keyed by stage family and
// routeMethod; unknown families fail closed to the full quality gate).

export { isPendingChatWorkCancellationTurn };

export function registerChatMessageRoutes(
  router: Router,
  ensureValidChatRouteScope: ChatRouteScopeGuard,
): void {
  /**
   * GET /api/v1/chat/actions/:pendingActionId
   * Returns a scoped pending action for token-zero skill handoff prefill.
   */
  router.get('/actions/:pendingActionId', asyncHandler(async (req, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Vary', 'Authorization');

    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidChatRouteScope(res, userId, tenantId, 'chat_pending_action_read')) {
      return;
    }
    const pendingActionId = String(req.params.pendingActionId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(pendingActionId)) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid pending action id' } });
      return;
    }
    const action = getPendingChatActionById({
      userId,
      tenantId,
      pendingActionId,
    });
    if (!action) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pending action not found' } });
      return;
    }
    res.json({
      ok: true,
      data: {
        id: action.id,
        schemaVersion: action.schemaVersion,
        skill: action.skill,
        action: action.action,
        status: action.status,
        collectedSlots: action.collectedSlots,
        missingSlots: action.missingSlots,
        riskClass: action.riskClass,
        locale: action.locale,
        timezone: action.timezone,
        originatingSurface: action.originatingSurface,
        expiresAt: action.expiresAt,
      },
      timestamp: new Date().toISOString(),
    });
  }));

  /**
   * POST /api/v1/chat/confirm-action
   * Executes a previously-issued pending confirmation token. This is a
   * deterministic write endpoint for iOS confirmation cards, not another
   * free-form chat turn.
   */
  router.post('/confirm-action', asyncHandler(async (req, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Vary', 'Authorization');

    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidChatRouteScope(res, userId, tenantId, 'chat_confirm_action')) {
      return;
    }

    const confirmationToken = String(req.body?.confirmation_token ?? req.body?.confirmationToken ?? '').trim();
    const intentClass = String(req.body?.intent_class ?? req.body?.intentClass ?? '').trim();
    const validation = validateChatConfirmationToken(confirmationToken, {
      userId,
      tenantId,
      intentClass: intentClass || null,
    });
    if (!validation.ok) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired confirmation token' } });
      return;
    }

    const replay = getCompletedChatConfirmation(confirmationToken, userId, tenantId);
    if (replay) {
      res.status(replay.statusCode).json(withIdempotentConfirmationReplay(replay.responseBody));
      return;
    }

    const v2Claim = claimPendingChatCoreV2Command(validation.payload.pendingId, userId, tenantId);
    if (v2Claim.status === 'already_claimed') {
      res.status(202).json({
        id: newAssistantMessageId(),
        text: 'I am still applying that confirmed change. I will reuse the completed result instead of running it twice.',
        domain: 'secretary',
        routeMethod: 'chat-core-v2-command-confirmation-in-progress',
        confidence: 1,
        buttons: null,
        metadata: {
          type: 'chat_core_v2_command_confirmation_in_progress',
          commandId: validation.payload.pendingId,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }
    if (v2Claim.status === 'claimed') {
      const confirmationStartedAt = Date.now();
      const execution = await executeChatCoreV2Command({
        command: v2Claim.pending.command,
        capabilityId: v2Claim.pending.capabilityId,
        userId,
        tenantId,
        locale: getUserLanguageById(userId) || undefined,
        now: new Date(confirmationStartedAt),
      });
      if (!execution.ok || !execution.response) {
        clearPendingChatCoreV2Command(validation.payload.pendingId, userId, tenantId);
        res.status(409).json({
          error: {
            code: 'CHAT_CORE_V2_CONFIRMATION_NOT_EXECUTABLE',
            message: execution.reason === 'command_gate_rejected'
              ? 'This preview is no longer safe to apply. Please ask again so I can refresh it.'
              : 'The confirmed Chat Core v2 command could not be executed.',
          },
        });
        return;
      }

      const response = buildChatCoreV2CommandConfirmationShortcutResponse({
        pending: v2Claim.pending,
        execution: execution as typeof execution & { response: NonNullable<typeof execution.response> },
        requestStartedAt: confirmationStartedAt,
      });
      recordConfirmedChatCoreV2CommandWriteEvidence({
        tenantId,
        userId,
        requestId: normalizeIdempotencyKey(req.body?.idempotencyKey)
          ?? `chat-core-v2-confirm:${tenantId}:${userId}:${v2Claim.pending.commandId}`,
        pending: v2Claim.pending,
        execution: execution as ChatCoreV2CommandExecutionResult,
        response,
      });
      rememberCompletedChatConfirmation({
        confirmationToken,
        userId,
        tenantId,
        expiresAt: v2Claim.pending.expiresAt,
        statusCode: 200,
        responseBody: response,
      });
      clearPendingChatCoreV2Command(validation.payload.pendingId, userId, tenantId);
      res.status(200).json(response);
      return;
    }

    const pending = getPendingChatConfirmation(userId, tenantId);
    if (!pending
      || pending.id !== validation.payload.pendingId
      || (pending.intentClass && pending.intentClass !== validation.payload.intentClass)
    ) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Confirmation token no longer matches a pending action' } });
      return;
    }

    const decision = findDecisionByRelatedEntity(userId, tenantId, 'chat_confirmation', pending.id);
    if (isChatCoreV2GuardOnlyPendingConfirmation(pending)) {
      const decisionResult = decision
        ? await performDecisionAction(decision.decisionId, 'option_a', userId, tenantId, {
          idempotencyKey: normalizeIdempotencyKey(req.body?.idempotencyKey)
            ?? `chat-core-v2-guard:${tenantId}:${userId}:${pending.id}`,
        })
        : null;
      const locale = resolveChatCoreV2RouteLocale(req, userId, pending.actionSummary);
      const response = {
        id: newAssistantMessageId(),
        text: buildChatCoreV2GuardOnlyConfirmationText(locale),
        domain: 'secretary',
        routeMethod: 'chat-core-v2-action-gateway-confirmation-hold',
        confidence: 1,
        buttons: null,
        metadata: {
          type: 'chat_core_v2_destructive_confirmation_hold',
          actionStatus: 'confirmation_acknowledged',
          verificationStatus: 'not_executed',
          pendingConfirmation: {
            kind: 'completed_confirmation',
            id: pending.id,
            intent_class: validation.payload.intentClass,
            intentClass: validation.payload.intentClass,
            expires_at: pending.expiresAt,
            expiresAt: pending.expiresAt,
          },
          chatCoreV2: {
            guardOnlyConfirmation: true,
            source: 'action_gateway',
            reasonCodes: pending.reasonCodes,
          },
          ...(decisionResult ? {
            confirmationDecision: {
              decisionId: decisionResult.item.decisionId,
              actionId: decisionResult.actionId,
              idempotent: decisionResult.idempotent,
              verification: decisionResult.verification,
            },
          } : {}),
        },
        timestamp: new Date().toISOString(),
        responseCards: [{
          kind: 'confirmationCard',
          title: buildChatCoreV2GuardOnlyConfirmationLabels(locale).title,
          message: buildChatCoreV2GuardOnlyConfirmationText(locale),
          destructive: true,
          confirmAction: null,
        }],
      };
      recordConfirmedChatActionWriteEvidence({
        tenantId,
        userId,
        requestId: normalizeIdempotencyKey(req.body?.idempotencyKey)
          ?? `chat-core-v2-guard:${tenantId}:${userId}:${pending.id}`,
        pending,
        status: 'needs_clarification',
        response,
      });
      rememberCompletedChatConfirmation({
        confirmationToken,
        userId,
        tenantId,
        expiresAt: pending.expiresAt,
        statusCode: 200,
        responseBody: response,
      });
      clearPendingChatConfirmation(userId, tenantId);
      res.status(200).json(response);
      return;
    }

    const decisionResult = decision
      ? await performDecisionAction(decision.decisionId, 'option_a', userId, tenantId, {
        idempotencyKey: normalizeIdempotencyKey(req.body?.idempotencyKey)
          ?? `chat-confirm:${tenantId}:${userId}:${pending.id}`,
      })
      : null;
    const confirmedAction = await executeConfirmedChatActionRuns({
      text: pending.actionSummary,
      userId,
      tenantId,
      conversationId: `confirm-${pending.id}`,
      messageId: `msg-confirm-${pending.id}`,
      sourceMessageId: pending.sourceMessageId,
      confirmedTargets: pending.confirmedTargets,
      channel: 'ios',
      locale: resolveChatCoreV2RouteLocale(req, userId, pending.actionSummary),
      timezone: getUserTimezoneById(userId),
    });

    if (!confirmedAction) {
      res.status(409).json({ error: { code: 'CONFIRMATION_NOT_EXECUTABLE', message: 'Pending action could not be executed' } });
      return;
    }

    const response = confirmedAction.response;
    if (decisionResult) {
      response.metadata.confirmationDecision = {
        decisionId: decisionResult.item.decisionId,
        actionId: decisionResult.actionId,
        idempotent: decisionResult.idempotent,
        verification: decisionResult.verification,
      };
    }
    response.metadata.pendingConfirmation = {
      kind: 'completed_confirmation',
      id: pending.id,
      intent_class: validation.payload.intentClass,
      intentClass: validation.payload.intentClass,
      expires_at: pending.expiresAt,
      expiresAt: pending.expiresAt,
    };

    const statusCode = statusForChatActionResponse(confirmedAction.status, response);
    recordConfirmedChatActionWriteEvidence({
      tenantId,
      userId,
      requestId: normalizeIdempotencyKey(req.body?.idempotencyKey)
        ?? `chat-confirm:${tenantId}:${userId}:${pending.id}`,
      pending,
      status: confirmedAction.status,
      response,
    });
    // Cache the completion before clearing pending so a concurrent duplicate confirm replays the result.
    rememberCompletedChatConfirmation({
      confirmationToken,
      userId,
      tenantId,
      expiresAt: pending.expiresAt,
      statusCode,
      responseBody: response,
    });
    clearPendingChatConfirmation(userId, tenantId);
    res.status(statusCode).json(response);
  }));

  /**
   * POST /api/v1/chat/message
   * Send a message — the iOS chat input entrypoint.
   * Assembles the per-turn context and runs the M10 ordered stage pipeline
   * (chat-pipeline/runner.ts); every terminal flows through the unified
   * finalizer inside its stage.
   */
  // The API composition root applies the shared per-user limiter before /chat.
  router.post('/message', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const {
      normalizedText,
      normalizedTextLower,
      normalizedAttachments,
      clientMessageId,
      idempotencyKey,
    } = normalizeChatMessageRequest(req.body);

    if (!ensureValidChatRouteScope(res, userId, tenantId, 'chat_route_message', {
      hasAttachments: normalizedAttachments.length > 0,
      textLength: normalizedText.length,
    })) {
      return;
    }

    if (!normalizedText && normalizedAttachments.length === 0) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'text or attachments are required' },
      });
      return;
    }

    let liveEvalContext;
    try {
      const readEvalHeader = (name: string) => req.header(name);
      liveEvalContext = hasChatLiveEvalHeaders(readEvalHeader)
        ? resolveChatLiveEvalRequest({
            readHeader: readEvalHeader,
            phase: 'turn',
            userId,
            tenantId,
            principalEmail: getUserById(userId)?.email ?? null,
            isLoopback: isLoopbackRequest(req),
          })
        : null;
    } catch (error) {
      if (error instanceof ChatLiveEvalContractError) {
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      throw error;
    }

    persistChatLanguagePreference(req, userId);

    // Token-zero reads/actions must never queue behind a long model call.
    // Acquire the per-user lock lazily only when this turn is definitely
    // entering a model-backed planner/provider path.
    // Keep the release callback in a mutable holder. TypeScript cannot track
    // assignments to a local variable made inside `ensureModelBudget`, and
    // otherwise narrows the finally-path optional call to `never`.
    const aiBudgetReservation = {
      release: null as (() => void) | null,
    };
    let modelBudgetAllowed = false;
    // Codex QA round 5: hoist idempotency ids OUT of the try block so
    // the catch can pass them to the degraded-response path. Without
    // this hoist the previous round-4 fix did not compile.
    const requestStartedAt = Date.now();
    const scopedClientMessageId = normalizeIdempotencyKey(
      clientMessageId ?? idempotencyKey ?? req.header('x-idempotency-key') ?? req.header('x-client-message-id'),
    );
    const userMessageId = buildUserMessageId(scopedClientMessageId, requestStartedAt);
    try {
      const ensureModelBudget = async (_logMessage: string): Promise<boolean> => {
        if (modelBudgetAllowed) return true;
        if (!aiBudgetReservation.release) {
          aiBudgetReservation.release = await acquireAiBudgetReservation({
            userId,
            requestSource: 'interactive',
            baseCategory: liveEvalContext?.targetBaseCategory ?? 'ios_chat_message',
            jobName: liveEvalContext?.scenarioId
              ? `chat_live_eval:${liveEvalContext.scenarioId}`
              : 'ios_chat_message',
            runId: liveEvalContext?.runId
              ?? getCurrentRequestId()
              ?? (req as any).requestId
              ?? `chat-${requestStartedAt}`,
            ...(liveEvalContext ? {
              estimatedCostUsd: 0,
              exactHardCostEstimate: true,
              hardRunCostLimitUsd: liveEvalContext.budget.targetCeilingUsd,
            } : {}),
          });
        }
        modelBudgetAllowed = true;
        return true;
      };
      const latency = createChatLatencyTracker(requestStartedAt);
      const chatRequestId = getCurrentRequestId() || (req as any).requestId || `chat-${Date.now()}`;

      recordChatStage(chatRequestId, 'request_received');

      const runPipeline = () => runChatMessagePipeline({
        req,
        res,
        userId,
        tenantId,
        normalizedText,
        normalizedTextLower,
        normalizedAttachments,
        scopedClientMessageId,
        userMessageId,
        requestStartedAt,
        chatRequestId,
        latency,
        ensureModelBudget,
      });
      if (liveEvalContext) {
        await runWithChatLiveEvalContext(liveEvalContext, runPipeline);
      } else {
        await runPipeline();
      }
    } catch (err: any) {
      const chatRequestId = getCurrentRequestId() || (req as any).requestId || `chat-${Date.now()}`;
      if (!res.headersSent && sendAiBudgetError(res, err)) return;
      // Codex QA round 4 / 5: the idempotency ids are now hoisted above
      // the try block, so they're in scope here and can flow into the
      // degraded-response persistence path.
      if (await sendRetryableChatFailureResponseIfNeeded({
        err,
        res,
        userId,
        tenantId,
        normalizedText,
        chatRequestId,
        userMessageId,
        clientMessageId: scopedClientMessageId ?? undefined,
      })) return;
      pushEvent({
        ts: new Date().toISOString(),
        type: 'error',
        summary: `chat failed (${chatRequestId})`,
        detail: 'Unhandled chat route failure',
        domain: 'secretary',
      });
      logger.error({ err, textLength: normalizedText.length, platform: 'ios', chatRequestId, tenantId, userId }, 'iOS chat/message failed');
      sendInternalError(res, 'Failed to process message');
    } finally {
      // Release the classified source/job/base/run reservation so the next
      // concurrent request can run its own check -> provider -> usage cycle.
      aiBudgetReservation.release?.();
    }
  });
}
