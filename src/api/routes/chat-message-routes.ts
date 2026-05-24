// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { routeMessage } from '../../router';
import { logger } from '../../utils/logger';
import { pushEvent } from '../../portal/telemetry';
import {
  claimUserChatMessage,
  findCompletedAssistantForClientMessage,
  listChatMessages,
} from '../../services/chat-history-store';
import { getUserLanguageById, getUserTimezoneById } from '../../services/user-service';
import { acquireCostLock, enforceCostGuardrails } from '../../services/cost-guardrail';
import { getCurrentRequestId } from '../../utils/request-context';
import {
  buildDefaultButtonsForChatDomain,
  getChatDomainHandler,
  rememberChatActiveDomain,
  resolveChatActiveContext,
} from './chat-message-context';
import {
  buildChatHandlerResponseEnvelope,
  executeChatDomainHandler,
} from './chat-message-execution';
import {
  analyzeChatSkillOrchestration,
  applyChatSkillRoutingDecision,
  buildChatSkillRoutingLogContext,
  type NexusSkillId,
} from '../../services/chat-skill-orchestrator';
import { runWithChatToolAuthorization } from '../../services/chat-tool-authorization';
import {
  buildBlocksFromMarkdown,
  type ChatResponseBlock,
} from '../../services/chat-response-blocks';
import {
  clearPendingChatConfirmation,
  getCompletedChatConfirmation,
  getPendingChatConfirmation,
  rememberCompletedChatConfirmation,
  trackPendingChatConfirmation,
  type PendingChatConfirmation,
} from '../../services/chat-pending-confirmations';
import {
  signChatConfirmationToken,
  validateChatConfirmationToken,
} from '../../services/chat-confirmation-token';
import { buildChatResponseSufficiencyMetadata } from '../../services/chat-response-sufficiency';
import { asyncHandler, sendInternalError } from '../response-helpers';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from './chat-persistence';
import { buildChatAttachmentResponse } from './chat-message-attachments';
import { tryBuildChatMessageShortcutResponse, tryBuildTokenZeroChatMessageShortcutResponse } from './chat-message-shortcuts';
import {
  getCachedChatCommandResponse,
  maybeCacheChatCommandResponse,
  tryBuildAuthenticatedIdentityResponse,
  tryBuildFastPathChatResponse,
  tryBuildTrainingPlanShortcutResponse,
} from './chat-message-local-responses';
import { parseContentScriptShortcut } from './chat-shortcut-parsers';
import {
  normalizeChatMessageRequest,
  persistChatLanguagePreference,
  sendChatQuotaExceededIfNeeded,
} from './chat-message-request';
import { sendChatTierRequiredIfNeeded } from './chat-message-tier-gate';
import { sendRetryableChatFailureResponseIfNeeded } from './chat-message-degraded-response';
import {
  executeConfirmedChatActionRuns,
  tryHandleChatActionPlan,
} from '../../services/chat';
import { getPendingChatActionById } from '../../services/chat-action-state';
import {
  buildNexusAnswerContract,
  createChatLatencyTracker,
  metadataGroundingFacts,
  type ChatLatencyTracker,
  type NexusAnswerContract,
  type NexusChatActionability,
  type NexusChatOwnerSkill,
  type NexusChatVerificationStatus,
} from '../../services/chat-answer-contract';
import { inferChatTurnContract, type ChatTurnContract } from '../../services/chat-turn-contract';
import { buildChatInternetResearchAnswer } from '../../services/chat-internet-research';
import { buildChatGroundingEnvelope } from '../../services/chat-grounding-layer';
import { applyChatFallbackPolicy } from '../../services/chat-fallback-policy';
import { applyChatResponseQualityGate } from '../../services/chat-response-quality-gate';
import { buildSimpleStateContext } from '../../domains/domain-handler';
import {
  isChatCoreV2ShadowRouteHookEnabled,
  isChatQualityGateEnabled,
  isChatResearchRouterEnabled,
  isChatTurnContractEnabled,
} from '../../services/runtime-flags';
import {
  runChatCoreV2ShadowRouteHook,
  tryBuildChatCoreV2DeterministicReadRoute,
} from '../../services/chat-core-v2';
import { buildChatCoreV2DeterministicReadShortcutResponse } from './chat-core-v2-deterministic-read-response';
import {
  createDecisionIntent,
  findDecisionByRelatedEntity,
  performDecisionAction,
} from '../../services/decision-center';

type ChatRouteScopeGuard = (
  res: Response,
  userId: number | undefined,
  tenantId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

export { clearChatActiveDomain } from './chat-message-context';

function normalizeIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
}

function buildUserMessageId(clientMessageId: string | null, fallbackTimestamp = Date.now()): string {
  return clientMessageId ? `msg-user-${clientMessageId}` : `msg-user-${fallbackTimestamp}`;
}

function isAcceptCurrentDecisionShortcut(text: string): boolean {
  return /^(accept|approve|confirm|yes|sim|aceitar|aprovar|confirmar)\s+(this|current|the)?\s*(decision|choice|clarification|decisão|escolha)?$/i.test(text.trim())
    || /\b(accept|approve|confirm)\s+this\s+decision\b/i.test(text)
    || /\b(aceitar|aprovar|confirmar)\s+esta\s+decis[aã]o\b/i.test(text);
}

function mapActionPlannerSkillToNexusSkill(skill: string): NexusSkillId {
  if (skill === 'secretary_calendar' || skill === 'mail' || skill === 'tasks') return 'secretary';
  if (skill === 'training') return 'training';
  if (skill === 'cooking') return 'cooking';
  if (skill === 'finance') return 'finance';
  if (skill === 'content') return 'content';
  return 'tools';
}

function intentClassForAction(action: string | undefined, fallbackSkills: string[] = []): string {
  switch (action) {
    case 'create_task':
    case 'create_task_with_subtasks':
      return 'task_create';
    case 'add_subtasks_to_task':
      return 'task_update';
    case 'delete_task':
      return 'task_delete';
    case 'complete_task':
      return 'task_complete';
    case 'update_task':
      return 'task_update';
    case 'schedule_event':
      return 'event_create';
    case 'move_event':
    case 'update_event':
      return 'event_move';
    case 'delete_event':
      return 'event_delete';
    case 'finance_payment_action':
      return 'financial_transfer';
    case 'finance_create_reminder':
    case 'finance_categorize_receipt':
      return 'finance_write';
    case 'send_email':
      return 'email_send';
    default:
      if (fallbackSkills.includes('finance')) return 'financial_transfer';
      if (fallbackSkills.includes('secretary')) return 'secretary_write';
      return action ? String(action).replace(/-/g, '_') : 'chat_action';
  }
}

function confirmationVariantForIntent(intentClass: string, reasonCodes: string[] = []): 'default' | 'destructive' | 'financial' {
  if (intentClass.startsWith('financial') || intentClass === 'fiscal_bundle_send') return 'financial';
  if (intentClass.includes('delete') || reasonCodes.some((reason) => reason.includes('destructive'))) return 'destructive';
  return 'default';
}

function attachPendingConfirmationContract(input: {
  response: { metadata?: Record<string, any> };
  pendingConfirmation: PendingChatConfirmation;
  intentClass: string;
  summary: Record<string, unknown>;
  decisionId?: string | null;
}): void {
  const token = signChatConfirmationToken({
    pendingId: input.pendingConfirmation.id,
    userId: input.pendingConfirmation.userId,
    tenantId: input.pendingConfirmation.tenantId,
    intentClass: input.intentClass,
    expiresAt: input.pendingConfirmation.expiresAt,
    sourceMessageId: input.pendingConfirmation.sourceMessageId ?? null,
  });
  const variant = confirmationVariantForIntent(input.intentClass, input.pendingConfirmation.reasonCodes);
  input.response.metadata = input.response.metadata ?? {};
  input.response.metadata.pendingConfirmation = {
    kind: 'pending_confirmation',
    id: input.pendingConfirmation.id,
    intent_class: input.intentClass,
    intentClass: input.intentClass,
    summary: input.summary,
    actionSummary: input.pendingConfirmation.actionSummary,
    confirmation_token: token,
    confirmationToken: token,
    expires_at: input.pendingConfirmation.expiresAt,
    expiresAt: input.pendingConfirmation.expiresAt,
    sourceMessageId: input.pendingConfirmation.sourceMessageId,
    decisionId: input.decisionId ?? null,
  };
  const existing = input.response.metadata.actionConfirmation && typeof input.response.metadata.actionConfirmation === 'object'
    ? input.response.metadata.actionConfirmation as Record<string, unknown>
    : {};
  input.response.metadata.actionConfirmation = {
    ...existing,
    variant,
    destructive: variant === 'destructive' || existing.destructive === true,
    requiresStrongConfirm: variant === 'financial',
    intentClass: input.intentClass,
    confirmationToken: token,
    expiresAt: input.pendingConfirmation.expiresAt,
    summary: input.summary,
    actionLabel: existing.actionLabel ?? (variant === 'financial' ? 'Confirm send' : 'Confirm'),
    cancelLabel: existing.cancelLabel ?? 'Cancel',
  };
}

function withIdempotentConfirmationReplay(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const response = body as Record<string, any>;
  return {
    ...response,
    metadata: {
      ...(response.metadata && typeof response.metadata === 'object' ? response.metadata : {}),
      idempotentReplay: true,
      confirmationReplay: true,
    },
  };
}

function domainForTurnContractSkill(skill: NexusChatOwnerSkill): string | null {
  switch (skill) {
    case 'secretary':
    case 'tasks':
    case 'connections':
    case 'notifications':
    case 'decision_center':
      return 'secretary';
    case 'training':
      return 'triathlon';
    case 'content':
    case 'finance':
    case 'cooking':
      return skill;
    default:
      return null;
  }
}

function shouldApplyTurnContractRouteHint(contract: ChatTurnContract, route: { domain: string; confidence: number }): boolean {
  if (contract.routeKind === 'action') return false;
  if (contract.riskClass === 'high' || contract.riskClass === 'destructive') return false;
  if (contract.skill === 'chat' || contract.skill === 'system' || contract.skill === 'owner_admin') return false;
  const hintedDomain = domainForTurnContractSkill(contract.skill);
  if (!hintedDomain || route.domain === hintedDomain) return false;
  return contract.confidence >= 0.8;
}

function applyTurnContractRouteHint<T extends { domain: string; method: string; confidence: number }>(
  route: T,
  contract: ChatTurnContract,
): T {
  if (!shouldApplyTurnContractRouteHint(contract, route)) return route;
  const hintedDomain = domainForTurnContractSkill(contract.skill);
  if (!hintedDomain) return route;
  return {
    ...route,
    domain: hintedDomain,
    method: `${route.method}+turn-contract`,
    confidence: Math.max(route.confidence, contract.confidence),
  };
}

function buildChatAnswerMetadata(input: {
  normalizedText: string;
  responseText: string;
  userId: number;
  tenantId: number;
  chatRequestId: string;
  routeMethod: string;
  domain: any;
  confidence: number;
  tracker: ChatLatencyTracker;
  latencyTier: Parameters<ChatLatencyTracker['snapshot']>[0];
  activeContext?: any;
  route?: any;
  routingDecision?: ReturnType<typeof analyzeChatSkillOrchestration>;
  existingMetadata?: Record<string, unknown> | null;
  actionability?: NexusChatActionability;
  verificationStatus?: NexusChatVerificationStatus;
  fallback?: Partial<NexusAnswerContract['fallback']>;
}): { text: string; metadata: Record<string, unknown>; contract: NexusAnswerContract } {
  try {
    const rolloutScope = { userId: input.userId, tenantId: input.tenantId };
    const turnContract = isChatTurnContractEnabled(process.env, rolloutScope)
      ? inferChatTurnContract({
        message: input.normalizedText,
        routedDomain: input.domain,
        activeContextDomain: input.activeContext?.domain ?? null,
        involvedSkills: input.routingDecision?.involvedSkills,
      })
      : null;
    const grounding = buildChatGroundingEnvelope({
      message: input.normalizedText,
      userId: input.userId,
      tenantId: input.tenantId,
      route: input.route,
      routedDomain: input.domain,
      activeContextDomain: input.activeContext?.domain ?? null,
      involvedSkills: input.routingDecision?.involvedSkills,
      contextSources: contextSourcesFromMetadata(input.existingMetadata),
    });
    const contract = buildNexusAnswerContract({
      intent: grounding.capability.intent,
      ownerSkill: turnContract?.skill ?? grounding.capability.ownerSkill,
      routeKind: turnContract?.routeKind,
      groundingRequirement: turnContract?.groundingRequired,
      expectedResponseShape: turnContract?.expectedResponseShape,
      language: turnContract?.language,
      ambiguityReasons: turnContract?.ambiguityReasons,
      routeMethod: input.routeMethod,
      confidence: Math.min(input.confidence, turnContract?.confidence ?? 1),
      groundingFacts: grounding.groundingFacts,
      missingFacts: grounding.missingFacts,
      staleness: grounding.staleness,
      riskLevel: turnContract?.riskClass === 'destructive' ? 'high' : turnContract?.riskClass,
      actionability: input.actionability ?? grounding.capability.actionability,
      verificationStatus: input.verificationStatus ?? 'not_required',
      fallback: input.fallback,
      userFacingSummary: input.responseText.slice(0, 240),
      nextBestActions: grounding.missingFacts.length > 0
        ? [{ id: 'clarify_missing_facts', label: 'Clarify missing details', kind: 'ask', targetSkill: grounding.capability.ownerSkill }]
        : [],
      traceId: input.chatRequestId,
      latency: input.tracker.snapshot(input.latencyTier, grounding.capability.capability.latencyBudgetMs),
    });
    const qualityGateEnabled = isChatQualityGateEnabled(process.env, rolloutScope);
    const fallbackPolicy = applyChatFallbackPolicy(contract);
    const gated = qualityGateEnabled
      ? applyChatResponseQualityGate({ text: input.responseText, contract: fallbackPolicy.contract })
      : { text: input.responseText, contract: fallbackPolicy.contract, status: 'pass' as const, issues: [], score: 1 };
    return {
      text: gated.text,
      contract: gated.contract,
      metadata: {
        ...(input.existingMetadata ?? {}),
        type: (input.existingMetadata?.type as string | undefined) ?? 'nexus_answer',
        chatReasoning: gated.contract,
        ...(turnContract ? { chatTurnContract: turnContract } : {}),
        groundingFacts: metadataGroundingFacts(gated.contract.groundingFacts),
        responseQuality: {
          status: gated.status,
          issues: [...fallbackPolicy.issues, ...gated.issues],
          score: gated.score,
          qualityGateDisabled: !qualityGateEnabled,
        },
        fallbackPolicy: fallbackPolicy.policy,
      },
    };
  } catch (err) {
    logger.error(
      { err, chatRequestId: input.chatRequestId, userId: input.userId, tenantId: input.tenantId },
      'Chat answer metadata build failed; returning original response text',
    );
    const contract = buildNexusAnswerContract({
      intent: 'chat.answer',
      ownerSkill: 'chat',
      routeMethod: input.routeMethod,
      confidence: Math.min(input.confidence, 0.5),
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      fallback: {
        fallbackType: 'deterministic_summary',
        fallbackReason: 'answer_contract_build_failed',
        retryable: false,
        userActionRequired: false,
        operatorActionRequired: true,
      },
      userFacingSummary: input.responseText.slice(0, 240),
      traceId: input.chatRequestId,
      latency: input.tracker.snapshot(input.latencyTier),
    });
    return {
      text: input.responseText,
      contract,
      metadata: {
        ...(input.existingMetadata ?? {}),
        type: (input.existingMetadata?.type as string | undefined) ?? 'nexus_answer',
        chatReasoning: contract,
        responseQuality: {
          status: 'blocked',
          issues: ['answer_contract_build_failed'],
          score: 0.2,
        },
      },
    };
  }
}

function contextSourcesFromMetadata(metadata: Record<string, unknown> | null | undefined): Array<{ source: string; freshness?: string; confidence?: number; reason?: string }> {
  if (!metadata) return [];
  const sources: Array<{ source: string; freshness?: string; confidence?: number; reason?: string }> = [];
  const type = typeof metadata.type === 'string' ? metadata.type : undefined;
  if (type) {
    sources.push({
      source: `metadata.${type}`,
      freshness: 'fresh',
      confidence: 0.85,
      reason: `Backend returned scoped ${type} metadata for this answer.`,
    });
  }
  if (typeof metadata.verificationStatus === 'string') {
    sources.push({
      source: 'metadata.verification_status',
      freshness: 'fresh',
      confidence: 0.9,
      reason: `Backend verifier reported ${metadata.verificationStatus}.`,
    });
  }
  if (metadata.responseSufficiency && typeof metadata.responseSufficiency === 'object') {
    sources.push({
      source: 'metadata.response_sufficiency',
      freshness: 'fresh',
      confidence: 0.8,
      reason: 'Response sufficiency metadata was available.',
    });
  }
  return sources;
}

function enrichChatResponseForContract<T extends {
  text: string;
  domain?: any;
  routeMethod?: string;
  confidence?: number;
  metadata?: unknown;
  responseBlocks?: ChatResponseBlock[];
}>(response: T, input: {
  normalizedText: string;
  userId: number;
  tenantId: number;
  chatRequestId: string;
  tracker: ChatLatencyTracker;
  latencyTier: Parameters<ChatLatencyTracker['snapshot']>[0];
  fallbackDomain?: any;
  fallbackRouteMethod?: string;
  fallbackConfidence?: number;
  actionability?: NexusChatActionability;
  verificationStatus?: NexusChatVerificationStatus;
  fallback?: Partial<NexusAnswerContract['fallback']>;
}): T {
  const existingMetadata = response.metadata && typeof response.metadata === 'object'
    ? response.metadata as Record<string, unknown>
    : null;
  const enriched = buildChatAnswerMetadata({
    normalizedText: input.normalizedText,
    responseText: response.text,
    userId: input.userId,
    tenantId: input.tenantId,
    chatRequestId: input.chatRequestId,
    routeMethod: response.routeMethod ?? input.fallbackRouteMethod ?? 'deterministic',
    domain: response.domain ?? input.fallbackDomain ?? 'chat',
    confidence: response.confidence ?? input.fallbackConfidence ?? 1,
    tracker: input.tracker,
    latencyTier: input.latencyTier,
    existingMetadata,
    actionability: input.actionability,
    verificationStatus: input.verificationStatus,
    fallback: input.fallback,
  });
  // Phase 16 batch 85 (2026-05-17): always emit responseBlocks alongside
  // text. The action-planner path already populates it; this branch fills
  // it for LLM domain handlers, fast-path, identity, and shortcut
  // responses that produce text without going through buildActionResponse.
  // We respect a caller-provided value if present (action planner emits it
  // already with planner-specific structure).
  const responseBlocks = response.responseBlocks ?? buildBlocksFromMarkdown(enriched.text);
  return {
    ...response,
    text: enriched.text,
    metadata: enriched.metadata,
    responseBlocks,
  } as T;
}

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

    const pending = getPendingChatConfirmation(userId, tenantId);
    if (!pending
      || pending.id !== validation.payload.pendingId
      || (pending.intentClass && pending.intentClass !== validation.payload.intentClass)
    ) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Confirmation token no longer matches a pending action' } });
      return;
    }

    const decision = findDecisionByRelatedEntity(userId, tenantId, 'chat_confirmation', pending.id);
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
      channel: 'ios',
      locale: getUserLanguageById(userId) || undefined,
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

    const statusCode = confirmedAction.status === 'needs_confirmation' || confirmedAction.status === 'needs_clarification' ? 202 : 200;
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
   * Send a message — equivalent to typing in Telegram.
   * Routes through Router → Domain Handler → returns AI response.
   *
   * For system commands (/day, /tasks, etc.), we route them through the
   * domain handler as natural language since the handler functions
   * accept the raw message text including the / prefix.
   */
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

    persistChatLanguagePreference(req, userId);

    // ── TOCTOU-safe cost window ─────────────────────────────────
    // Acquire the per-user cost lock BEFORE the quota check so that
    // concurrent iOS requests from the same user serialize through
    // the check → AI → api_usage INSERT boundary. Without this,
    // two parallel calls could both pass the cap check, both spend,
    // and together exceed the daily budget. See
    // `acquireCostLock` docs in services/cost-guardrail.ts.
    const releaseCostLock = await acquireCostLock(userId);
    try {
      const requestStartedAt = Date.now();
      const latency = createChatLatencyTracker(requestStartedAt);
      const chatRequestId = getCurrentRequestId() || (req as any).requestId || `chat-${Date.now()}`;
      const scopedClientMessageId = normalizeIdempotencyKey(
        clientMessageId ?? idempotencyKey ?? req.header('x-idempotency-key') ?? req.header('x-client-message-id'),
      );
      const userMessageId = buildUserMessageId(scopedClientMessageId, requestStartedAt);

      const idempotentHit = findCompletedAssistantForClientMessage(userId, scopedClientMessageId, tenantId);
      if (idempotentHit) {
        if (idempotentHit.userText !== normalizedText) {
          logger.warn(
            { chatRequestId, tenantId, userId, clientMessageId: scopedClientMessageId },
            'iOS chat idempotent retry used a client message id with different text',
          );
          res.status(409).json({
            error: {
              code: 'CHAT_IDEMPOTENCY_CONFLICT',
              message: 'This chat request id was already used for a different message.',
            },
          });
          return;
        }
        logger.info(
          { chatRequestId, tenantId, userId, clientMessageId: scopedClientMessageId },
          'iOS chat idempotent retry returned existing assistant message',
        );
        res.json({
          id: idempotentHit.assistantMessage.id,
          text: idempotentHit.assistantMessage.text,
          domain: idempotentHit.assistantMessage.domain,
          routeMethod: idempotentHit.assistantMessage.routeMethod ?? 'idempotent-replay',
          confidence: idempotentHit.assistantMessage.confidence ?? 1,
          buttons: idempotentHit.assistantMessage.buttons ?? null,
          metadata: {
            ...(idempotentHit.assistantMessage.metadata && typeof idempotentHit.assistantMessage.metadata === 'object'
              ? idempotentHit.assistantMessage.metadata as Record<string, unknown>
              : {}),
            idempotentReplay: true,
            replayOfUserMessageId: idempotentHit.userMessageId,
          },
          timestamp: idempotentHit.assistantMessage.timestamp,
        });
        return;
      }

      const isNewUserFlow = listChatMessages(userId, 1, undefined, tenantId).messages.length === 0;

      if (scopedClientMessageId) {
        const claim = claimUserChatMessage({
          userId,
          tenantId,
          messageId: userMessageId,
          text: normalizedText,
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
          timestamp: new Date(requestStartedAt).toISOString(),
        });
        if (claim.status === 'conflict') {
          logger.warn(
            { chatRequestId, tenantId, userId, clientMessageId: scopedClientMessageId },
            'iOS chat idempotency claim conflicted with existing message text',
          );
          res.status(409).json({
            error: {
              code: 'CHAT_IDEMPOTENCY_CONFLICT',
              message: 'This chat request id was already used for a different message.',
            },
          });
          return;
        }
        if (claim.status === 'duplicate') {
          logger.info(
            { chatRequestId, tenantId, userId, clientMessageId: scopedClientMessageId, lifecycleState: claim.existingLifecycleState },
            'iOS chat idempotent retry found an in-flight message claim',
          );
          const response = enrichChatResponseForContract({
            id: `msg-${requestStartedAt}`,
            text: 'I am still processing that request. I will reuse the original result instead of running the action again.',
            domain: 'secretary',
            routeMethod: 'idempotency-in-progress',
            confidence: 1,
            buttons: null,
            metadata: {
              type: 'chat_idempotency_in_progress',
              idempotencyInProgress: true,
              replayOfUserMessageId: claim.messageId,
            },
            timestamp: new Date(requestStartedAt).toISOString(),
          }, {
            normalizedText,
            userId,
            tenantId,
            chatRequestId,
            tracker: latency,
            latencyTier: 'tier4_long_running',
            actionability: 'degraded',
            verificationStatus: 'pending',
          });
          res.status(202).json(response);
          return;
        }
      }

      logger.info(
        {
          chatRequestId,
          tenantId,
          userId,
          platform: 'ios',
          isNewUserFlow,
          hasAttachments: normalizedAttachments.length > 0,
          textLength: normalizedText.length,
        },
        'iOS chat request started',
      );
      latency.mark('request_validated');

      const quotaDecision = enforceCostGuardrails(userId);
      const tokenZeroShortcut = normalizedText && normalizedAttachments.length === 0
        ? await tryBuildTokenZeroChatMessageShortcutResponse({
          normalizedText,
          userId,
          userLanguage: getUserLanguageById(userId),
        })
        : null;
      if (tokenZeroShortcut) {
        const { conversationDomain } = tokenZeroShortcut;
        if (sendChatTierRequiredIfNeeded(res, userId, conversationDomain)) return;
        const response = enrichChatResponseForContract(tokenZeroShortcut.response, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier1_fast_read',
          fallbackDomain: conversationDomain,
          fallbackRouteMethod: tokenZeroShortcut.response.routeMethod,
          actionability: 'answer_only',
          verificationStatus: 'not_required',
        });
        rememberChatActiveDomain(userId, conversationDomain, Date.now(), tenantId);
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
        res.json(response);
        return;
      }

      const chatCoreV2Read = normalizedText && normalizedAttachments.length === 0
        ? tryBuildChatCoreV2DeterministicReadRoute({
          normalizedText,
          userId,
          tenantId,
          locale: getUserLanguageById(userId),
          timezone: getUserTimezoneById(userId),
          now: new Date(requestStartedAt),
        })
        : null;
      if (chatCoreV2Read) {
        latency.mark('chat_core_v2_deterministic_read_completed');
        const deterministicReadShortcut = buildChatCoreV2DeterministicReadShortcutResponse({
          result: chatCoreV2Read,
          requestStartedAt,
        });
        const { conversationDomain, response: shortcutResponse } = deterministicReadShortcut;
        const response = enrichChatResponseForContract(shortcutResponse, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier1_fast_read',
          fallbackDomain: conversationDomain,
          fallbackRouteMethod: 'chat-core-v2-deterministic-read',
          actionability: 'answer_only',
          verificationStatus: 'not_required',
        });
        rememberChatActiveDomain(userId, conversationDomain, Date.now(), tenantId);
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
        logger.info(
          {
            chatRequestId,
            platform: 'ios',
            mode: 'chat-core-v2-deterministic-read',
            tenantId,
            userId,
            capabilityId: deterministicReadShortcut.logContext.capabilityId,
            contextHash: deterministicReadShortcut.logContext.contextHash,
          },
          'iOS chat Chat Core v2 deterministic read hit',
        );
        res.json(response);
        return;
      }

      // ── Cost cap enforcement ─────────────────────────────────────
      // Run before any model-backed planner/reasoning path. Token-zero
      // deterministic reads above remain available after quota exhaustion.
      if (quotaDecision.block && sendChatQuotaExceededIfNeeded(res, userId, 'iOS chat: user over daily cost cap')) return;

      if (isChatCoreV2ShadowRouteHookEnabled(process.env, { userId, tenantId })) {
        const shadow = runChatCoreV2ShadowRouteHook({
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          userMessageId,
          clientMessageId: scopedClientMessageId,
          attachmentsCount: normalizedAttachments.length,
          locale: getUserLanguageById(userId),
          timezone: getUserTimezoneById(userId),
          now: new Date(requestStartedAt),
        });
        if (shadow.recorded) {
          logger.info(
            {
              chatRequestId,
              tenantId,
              userId,
              routeMethod: shadow.result?.routeDecision.routeMethod,
              reasoningTier: shadow.result?.routeDecision.reasoningTier,
              replayBundleId: shadow.replayBundleId,
            },
            'Chat Core v2 shadow route hook recorded plan',
          );
        }
      }

      // ── General Action Planner ─────────────────────────────────
      // Natural-language write intents must be routed before read-only
      // fast paths. Example: "agenda do Gmail" with event semantics means
      // Google Calendar, not Gmail unread count.
      if (normalizedText && normalizedAttachments.length === 0 && !parseContentScriptShortcut(normalizedText)) {
        const actionResult = await tryHandleChatActionPlan({
          text: normalizedText,
          userId,
          tenantId,
          conversationId: scopedClientMessageId ?? chatRequestId,
          messageId: userMessageId,
          channel: 'ios',
          locale: getUserLanguageById(userId) || undefined,
          timezone: getUserTimezoneById(userId),
          requireSafeWriteConfirmation: true,
        });
        if (actionResult) {
          latency.mark('action_planner_completed');
          const response = actionResult.response;
          if (actionResult.status === 'needs_confirmation') {
            const lang = getUserLanguageById(userId);
            const isPT = lang.startsWith('pt');
            const involvedSkills = [...new Set(actionResult.plan.steps.map((step) => mapActionPlannerSkillToNexusSkill(step.skill)))];
            const reasonCodes = [...new Set(actionResult.plan.steps.map((step) => `${step.risk}_requires_confirmation`))];
            const intentClass = intentClassForAction(actionResult.plan.steps[0]?.action, involvedSkills);
            const summary = {
              text: response.text || normalizedText,
              steps: actionResult.plan.steps.map((step) => ({
                skill: step.skill,
                action: step.action,
                risk: step.risk,
                args: step.args,
              })),
            };
            const pendingConfirmation = trackPendingChatConfirmation({
              userId,
              tenantId,
              actionSummary: response.text || normalizedText,
              involvedSkills,
              reasonCodes,
              intentClass,
              summary,
              sourceMessageId: userMessageId,
            });
            const decisionResult = await createDecisionIntent({
              userId,
              tenantId,
              sourceSkill: 'chat',
              type: 'decision_required',
              priority: 'active',
              relatedEntityId: pendingConfirmation.id,
              relatedEntityType: 'chat_confirmation',
              title: isPT ? 'Nexus precisa de confirmação' : 'Nexus needs confirmation',
              body: pendingConfirmation.actionSummary,
              sensitiveBody: pendingConfirmation.actionSummary,
              actionButtons: [
                { id: 'option_a', label: isPT ? 'Confirmar' : 'Confirm', style: 'primary' },
                { id: 'option_b', label: isPT ? 'Não executar' : 'Do not run', style: 'secondary' },
                { id: 'open_detail', label: isPT ? 'Abrir decisão' : 'Open decision', style: 'secondary' },
              ],
              deeplink: `nexus://notifications/${pendingConfirmation.id}`,
              expiresAt: pendingConfirmation.expiresAt,
              dedupeKey: `chat:action-confirmation:${tenantId}:${userId}:${pendingConfirmation.id}`,
              requiresUserAction: true,
              deliveryPolicy: 'in_app_only',
              privacyPolicy: 'standard',
            });
            attachPendingConfirmationContract({
              response,
              pendingConfirmation,
              intentClass,
              summary,
              decisionId: decisionResult.item?.decisionId ?? null,
            });
          }
          rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId);
          persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
            clientMessageId: scopedClientMessageId,
            requestId: chatRequestId,
          });
          syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
          logger.info(
            {
              chatRequestId,
              tenantId,
              userId,
              routeMethod: response.routeMethod,
              actionStatus: actionResult.status,
              planner: actionResult.plan.planner,
              involvedSkills: actionResult.plan.steps.map((step) => step.skill),
            },
            'iOS chat action planner handled request',
          );
          res.status(actionResult.status === 'needs_confirmation' || actionResult.status === 'needs_clarification' ? 202 : 200).json(response);
          return;
        }
      }

      // Check cache for known deterministic commands (saves $0.02-0.05 per hit)
      if (normalizedText && normalizedAttachments.length === 0) {
        const cached = getCachedChatCommandResponse(userId, normalizedTextLower, tenantId);
        if (cached) {
          logger.debug({ cmdLength: normalizedText.length, platform: 'ios', tenantId, userId }, 'Returning cached chat command');
          const cachedResponse = enrichChatResponseForContract(cached, {
            normalizedText,
            userId,
            tenantId,
            chatRequestId,
            tracker: latency,
            latencyTier: 'tier0_local',
            actionability: 'answer_only',
            verificationStatus: 'not_required',
          });
          persistExchange(userId, userMessageId, normalizedText, cachedResponse.id, cachedResponse, tenantId, {
            clientMessageId: scopedClientMessageId,
            requestId: chatRequestId,
          });
          syncConversationStateForShortcut(userId, cachedResponse.domain, normalizedText, cachedResponse.text, tenantId);
          res.json(cachedResponse);
          return;
        }
      }

      if (normalizedAttachments.length > 0) {
        if (sendChatQuotaExceededIfNeeded(res, userId, 'iOS chat attachment blocked by quota')) return;

        const attachment = normalizedAttachments[0];
        const lang = getUserLanguageById(userId) || 'pt-BR';
        const result = await buildChatAttachmentResponse({
          attachment,
          normalizedText,
          userId,
          tenantId,
          language: lang,
        });
        rememberChatActiveDomain(userId, result.conversationDomain, Date.now(), tenantId);
        const response = enrichChatResponseForContract(result.response, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: result.degraded ? 'tier4_long_running' : 'tier2_verified_write',
          fallbackDomain: result.conversationDomain,
          fallbackRouteMethod: 'attachment',
          actionability: result.degraded ? 'degraded' : 'answer_only',
          verificationStatus: result.degraded ? 'failed' : 'not_required',
          fallback: result.degraded ? {
            fallbackType: 'deterministic_summary',
            fallbackReason: result.degradedReason ?? 'attachment_processing_degraded',
            retryable: true,
            userActionRequired: false,
            operatorActionRequired: false,
          } : undefined,
        });
        persistExchange(userId, userMessageId, result.userText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, result.conversationDomain, result.userText, response.text, tenantId);
        if (result.degraded) {
          logger.warn(
            { err: result.error, chatRequestId, userId, reason: result.degradedReason, platform: 'ios' },
            'iOS chat attachment degraded',
          );
        }
        res.json(response);
        return;
      }

      // ── Authenticated identity fast-path ────────────────────────────
      // Identity questions must be answered from the server-scoped auth
      // session, not from a domain prompt or model memory. This prevents
      // founder/default persona text from ever overriding the logged-in
      // user's real account identity.
      const identityResponse = tryBuildAuthenticatedIdentityResponse(normalizedText, normalizedTextLower, userId);
      if (identityResponse) {
        const { conversationDomain } = identityResponse;
        const response = enrichChatResponseForContract(identityResponse.response, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier1_fast_read',
          fallbackDomain: conversationDomain,
          fallbackRouteMethod: 'authenticated-identity',
          actionability: 'answer_only',
          verificationStatus: 'not_required',
        });
        rememberChatActiveDomain(userId, conversationDomain, Date.now(), tenantId);
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
        logger.info({ chatRequestId, platform: 'ios', mode: 'authenticated-identity', tenantId, userId }, 'iOS chat authenticated identity fast-path hit');
        res.json(response);
        return;
      }

      // ── Token-zero fast-path ─────────────────────────────────────
      // Slash commands like /todo, /day, /overdue are pure data lookups.
      // Handle them directly without ever touching the AI pipeline.
      // They intentionally remain behind the quota gate above until product
      // explicitly approves them as cap-bypass reads.
      // This is the difference between an instant ~200ms response and a
      // 30-50 second Claude tool-use loop. See specs/08-TOKEN-ZERO-ARCHITECTURE.md.
      const fastPath = await tryBuildFastPathChatResponse(normalizedText, normalizedTextLower, userId, tenantId);
      if (fastPath) {
        const { response: fastResponse, conversationDomain } = fastPath;
        const response = enrichChatResponseForContract(fastResponse, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier1_fast_read',
          fallbackDomain: conversationDomain,
          fallbackRouteMethod: 'fast-path',
          actionability: 'answer_only',
          verificationStatus: 'not_required',
        });
        // Track domain for conversation continuity even on fast-path.
        rememberChatActiveDomain(userId, conversationDomain, Date.now(), tenantId);
        // Cache deterministic responses for the next 60 seconds.
        maybeCacheChatCommandResponse(userId, normalizedTextLower, response, tenantId);
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
        logger.info({ cmdLength: normalizedText.length, platform: 'ios', mode: 'fast-path', tenantId, userId }, 'iOS chat fast-path hit');
        res.json(response);
        return;
      }

      // ── Natural language plan-creation shortcut ───────────────────
      // Intercept "criar plano" / "create training plan" before the AI
      // pipeline. Returns a token-zero response directing the user to
      // the Training tab's one-shot plan generator ($0.01 vs $0.15).
      const trainingPlanShortcut = tryBuildTrainingPlanShortcutResponse(normalizedText, normalizedTextLower, userId);
      if (trainingPlanShortcut) {
        const { response: planResponse, conversationDomain } = trainingPlanShortcut;
        const response = enrichChatResponseForContract(planResponse, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier1_fast_read',
          fallbackDomain: conversationDomain,
          fallbackRouteMethod: 'training-plan-shortcut',
          actionability: 'preview',
          verificationStatus: 'not_required',
        });
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
        res.json(response);
        return;
      }

      const activeContext = resolveChatActiveContext(userId, Date.now(), tenantId);
      const preRoutingDecision = analyzeChatSkillOrchestration({
        message: normalizedText,
        activeContext,
        userId,
        tenantId,
      });
      const turnContractEnabled = isChatTurnContractEnabled(process.env, { userId, tenantId });
      const preTurnContract = turnContractEnabled
        ? inferChatTurnContract({
          message: normalizedText,
          activeContextDomain: activeContext?.domain ?? null,
          involvedSkills: preRoutingDecision.involvedSkills,
        })
        : null;

      if (
        isChatResearchRouterEnabled(process.env, { userId, tenantId })
        && preTurnContract?.routeKind === 'internet_research'
        && (preTurnContract.groundingRequired === 'web' || preTurnContract.groundingRequired === 'local_and_web')
      ) {
        const researchDomain = domainForTurnContractSkill(preTurnContract.skill) ?? 'chat';
        const localContext = preTurnContract.groundingRequired === 'local_and_web' && researchDomain !== 'chat'
          ? await buildSimpleStateContext(researchDomain, userId, normalizedText, tenantId)
          : null;
        const research = await buildChatInternetResearchAnswer({
          message: normalizedText,
          language: preTurnContract.language,
          skill: preTurnContract.skill,
          expectedResponseShape: preTurnContract.expectedResponseShape,
          userId,
          tenantId,
          groundingRequired: preTurnContract.groundingRequired,
          localContext,
        });
        latency.mark('internet_research_completed');
        const response = enrichChatResponseForContract({
          id: `msg-${Date.now()}`,
          text: research.text,
          domain: researchDomain,
          routeMethod: 'internet-research',
          confidence: research.degraded ? 0.55 : preTurnContract.confidence,
          buttons: null,
          metadata: {
            type: 'chat_internet_research',
            webSources: research.sources,
            degraded: research.degraded,
            degradedReason: research.degradedReason ?? null,
            routeKind: preTurnContract.routeKind,
            groundingRequired: preTurnContract.groundingRequired,
            contextCompiler: research.context ?? null,
          },
          timestamp: new Date().toISOString(),
        }, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier4_long_running',
          fallbackDomain: researchDomain,
          fallbackRouteMethod: 'internet-research',
          fallbackConfidence: research.degraded ? 0.55 : preTurnContract.confidence,
          actionability: research.degraded ? 'degraded' : 'answer_only',
          verificationStatus: research.sources.length > 0 ? 'verified' : 'not_required',
          fallback: research.degraded ? {
            fallbackType: 'model_unavailable',
            fallbackReason: research.degradedReason ?? 'web_research_unavailable',
            retryable: true,
            userActionRequired: false,
            operatorActionRequired: false,
          } : undefined,
        });
        rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId);
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
        logger.info(
          {
            chatRequestId,
            tenantId,
            userId,
            skill: preTurnContract.skill,
            sourceCount: research.sources.length,
            degraded: research.degraded,
          },
          'iOS chat handled selective internet research turn',
        );
        res.json(response);
        return;
      }

      if (isAcceptCurrentDecisionShortcut(normalizedTextLower)) {
        const pending = getPendingChatConfirmation(userId, tenantId);
        const decision = pending
          ? findDecisionByRelatedEntity(userId, tenantId, 'chat_confirmation', pending.id)
          : null;
        if (pending && decision) {
          const result = await performDecisionAction(decision.decisionId, 'option_a', userId, tenantId, {
            idempotencyKey: normalizeIdempotencyKey(req.body?.idempotencyKey)
              ?? `chat-confirm:${tenantId}:${userId}:${pending.id}:${Date.now()}`,
          });
          const confirmedAction = await executeConfirmedChatActionRuns({
            text: pending.actionSummary,
            userId,
            tenantId,
            conversationId: scopedClientMessageId ?? chatRequestId,
            messageId: userMessageId,
            sourceMessageId: pending.sourceMessageId,
            channel: 'ios',
            locale: getUserLanguageById(userId) || undefined,
            timezone: getUserTimezoneById(userId),
          });
          if (confirmedAction) {
            clearPendingChatConfirmation(userId, tenantId);
            const response = confirmedAction.response;
            response.metadata.confirmationDecision = {
              decisionId: result.item.decisionId,
              actionId: result.actionId,
              idempotent: result.idempotent,
              verification: result.verification,
            };
            rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId);
            persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
              clientMessageId: scopedClientMessageId,
              requestId: chatRequestId,
            });
            syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
            res.status(confirmedAction.status === 'needs_confirmation' || confirmedAction.status === 'needs_clarification' ? 202 : 200).json(response);
            return;
          }
          const response = enrichChatResponseForContract({
            id: `msg-${Date.now()}`,
            text: getUserLanguageById(userId).startsWith('pt')
              ? 'Confirmado. A decisão foi registada no Decision Center e verificada pelo servidor.'
              : 'Confirmed. The decision was recorded in Decision Center and verified by the server.',
            domain: 'chat',
            routeMethod: 'decision-center-action',
            confidence: 0.95,
            buttons: null,
            metadata: {
              type: 'decision_center_chat_confirmation_actioned',
              decisionId: result.item.decisionId,
              actionId: result.actionId,
              idempotent: result.idempotent,
              verification: result.verification,
            },
            timestamp: new Date().toISOString(),
          }, {
            normalizedText,
            userId,
            tenantId,
            chatRequestId,
            tracker: latency,
            latencyTier: 'tier2_verified_write',
            actionability: 'execute',
            verificationStatus: 'verified',
          });
          persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
            clientMessageId: scopedClientMessageId,
            requestId: chatRequestId,
          });
          res.json(response);
          return;
        }
      }

      if (preRoutingDecision.safety.requiresConfirmation && !preRoutingDecision.safety.explicitConfirmation) {
        const lang = getUserLanguageById(userId);
        const isPT = lang.startsWith('pt');
        const intentClass = intentClassForAction(undefined, preRoutingDecision.involvedSkills);
        const summary = {
          text: normalizedText,
          involvedSkills: preRoutingDecision.involvedSkills,
          reasonCodes: preRoutingDecision.safety.confirmationReasonCodes,
        };
        const pendingConfirmation = trackPendingChatConfirmation({
          userId,
          tenantId,
          actionSummary: normalizedText,
          involvedSkills: preRoutingDecision.involvedSkills,
          reasonCodes: preRoutingDecision.safety.confirmationReasonCodes,
          intentClass,
          summary,
          sourceMessageId: userMessageId,
        });
        const decisionResult = await createDecisionIntent({
          userId,
          tenantId,
          sourceSkill: 'chat',
          type: 'decision_required',
          priority: 'active',
          relatedEntityId: pendingConfirmation.id,
          relatedEntityType: 'chat_confirmation',
          title: isPT ? 'Nexus precisa de confirmação' : 'Nexus needs confirmation',
          body: pendingConfirmation.actionSummary,
          sensitiveBody: pendingConfirmation.actionSummary,
          actionButtons: [
            { id: 'option_a', label: isPT ? 'Confirmar' : 'Confirm', style: 'primary' },
            { id: 'option_b', label: isPT ? 'Não executar' : 'Do not run', style: 'secondary' },
            { id: 'open_detail', label: isPT ? 'Abrir decisão' : 'Open decision', style: 'secondary' },
          ],
          deeplink: `nexus://notifications/${pendingConfirmation.id}`,
          expiresAt: pendingConfirmation.expiresAt,
          dedupeKey: `chat:confirmation:${tenantId}:${userId}:${pendingConfirmation.id}`,
          requiresUserAction: true,
          deliveryPolicy: 'in_app_only',
          privacyPolicy: 'standard',
        });
        const sufficiency = buildChatResponseSufficiencyMetadata({
          actionStatus: 'needs_confirmation',
          requiresConfirmation: true,
          unresolvedBlockers: ['target_identity_required'],
        });
        const confirmationResponse = enrichChatResponseForContract({
          id: `msg-${Date.now()}`,
          text: isPT
            ? 'Antes de executar isso, preciso de confirmação explícita. Confirme a ação exata que quer que eu faça, incluindo o item/plano/evento afetado. Não vou apagar, cancelar, enviar ou limpar nada sem essa confirmação.'
            : 'Before I execute that, I need explicit confirmation. Please confirm the exact action you want, including the affected item, plan, event, or message. I will not delete, cancel, send, or clear anything without that confirmation.',
          domain: preRoutingDecision.primaryDomain || 'secretary',
          routeMethod: 'confirmation-required',
          confidence: preRoutingDecision.confidence,
          buttons: null,
          metadata: {
            type: 'chat_action_confirmation_required',
            actionStatus: sufficiency.actionStatus,
            involvedSkills: preRoutingDecision.involvedSkills,
            reasonCodes: preRoutingDecision.safety.confirmationReasonCodes,
            unresolvedBlockers: sufficiency.unresolvedBlockers,
            responseSufficiency: sufficiency,
            actionConfirmation: {
              title: isPT ? 'Confirmação necessária' : 'Confirmation needed',
              message: pendingConfirmation.actionSummary,
              destructive: confirmationVariantForIntent(intentClass, preRoutingDecision.safety.confirmationReasonCodes) === 'destructive',
              variant: confirmationVariantForIntent(intentClass, preRoutingDecision.safety.confirmationReasonCodes),
              requiresStrongConfirm: confirmationVariantForIntent(intentClass, preRoutingDecision.safety.confirmationReasonCodes) === 'financial',
            },
          },
          timestamp: new Date().toISOString(),
        }, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier2_verified_write',
          actionability: 'preview',
          verificationStatus: 'pending',
        });
        attachPendingConfirmationContract({
          response: confirmationResponse,
          pendingConfirmation,
          intentClass,
          summary,
          decisionId: decisionResult.item?.decisionId ?? null,
        });
        rememberChatActiveDomain(userId, confirmationResponse.domain, Date.now(), tenantId);
        persistExchange(userId, userMessageId, normalizedText, confirmationResponse.id, confirmationResponse, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, confirmationResponse.domain, normalizedText, confirmationResponse.text, tenantId);
        logger.info(
          { chatRequestId, userId, tenantId, orchestration: buildChatSkillRoutingLogContext(preRoutingDecision) },
          'iOS chat destructive action paused for confirmation',
        );
        res.json(confirmationResponse);
        return;
      }

      // Route the message (handles both commands and natural language).
      // April 9 2026: thread userId into routeMessage so the classifier
      // cost row in api_usage attributes this call to the real user
      // instead of user_id=0. Without this, every iOS chat message's
      // classification cost was orphaned under user_id=0 and the
      // per-user cap (isUserOverDailyCap) couldn't see the spend.
      const rawRoute = await routeMessage(normalizedText, activeContext, userId, tenantId);
      latency.mark('routed');
      const contractAwareRoute = preTurnContract ? applyTurnContractRouteHint(rawRoute, preTurnContract) : rawRoute;
      const routingDecision = analyzeChatSkillOrchestration({
        message: normalizedText,
        activeContext,
        routedDomain: contractAwareRoute.domain,
        userId,
        tenantId,
      });
      const pendingConfirmation = routingDecision.safety.explicitConfirmation
        ? getPendingChatConfirmation(userId, tenantId)
        : null;
      const route = applyChatSkillRoutingDecision(contractAwareRoute, routingDecision);
      logger.info(
        {
          chatRequestId,
          domain: route.domain,
          method: route.method,
          confidence: route.confidence,
          platform: 'ios',
          orchestration: buildChatSkillRoutingLogContext(routingDecision),
          rawDomain: rawRoute.domain,
          contractHintedDomain: contractAwareRoute.domain !== rawRoute.domain ? contractAwareRoute.domain : null,
        },
        'iOS message routed',
      );

      // Track domain for continuity
      rememberChatActiveDomain(userId, route.domain, Date.now(), tenantId);

      // ─── Phase 1 Slice C — Tier gate for iOS chat entrypoint ───
      // Same two-layer check as the Telegram handler: explicit disable
      // first, then tier requirement. Fail-open on errors so a bus of
      // signal service issue never locks users out of their data.
      if (sendChatTierRequiredIfNeeded(res, userId, route.domain)) return;

      // Execute domain handler
      const handler = getChatDomainHandler(route.domain);
      if (!handler) {
        res.status(400).json({
          error: { code: 'UNKNOWN_DOMAIN', message: `No handler for domain: ${route.domain}` },
        });
        return;
      }

      const shortcutResult = await tryBuildChatMessageShortcutResponse({
        route,
        normalizedText,
        userId,
        tenantId,
        userLanguage: getUserLanguageById(userId),
        activeContext,
      });
      if (shortcutResult) {
        const { conversationDomain } = shortcutResult;
        const response = enrichChatResponseForContract(shortcutResult.response, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier1_fast_read',
          fallbackDomain: conversationDomain,
          fallbackRouteMethod: route.method,
          fallbackConfidence: route.confidence,
          actionability: 'answer_only',
          verificationStatus: 'not_required',
        });
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
        res.json(response);
        return;
      }

      const result = await runWithChatToolAuthorization({
        userId,
        tenantId,
        confirmedDestructiveAction: routingDecision.safety.explicitConfirmation,
        confirmationSource: routingDecision.safety.explicitConfirmation
          ? pendingConfirmation ? 'pending_confirmation' : 'explicit_current_turn'
          : 'none',
        requireConfirmationForWrites: true,
      }, () => executeChatDomainHandler(handler, route.strippedMessage, userId, tenantId));
      latency.mark('domain_handler_completed');
      if (routingDecision.safety.explicitConfirmation) {
        clearPendingChatConfirmation(userId, tenantId);
      }

      // Extract buttons from the response text if present.
      // Secretary fast-path messages expose deterministic command buttons.
      // Triathlon coach replies can expose real "apply recommendation"
      // actions when the current request produced fresh coach state.
      const lang = getUserLanguageById(userId);
      const buttons = buildDefaultButtonsForChatDomain(result.domain || route.domain, lang, userId, requestStartedAt, tenantId);

      const enriched = buildChatAnswerMetadata({
        normalizedText,
        responseText: result.text,
        userId,
        tenantId,
        chatRequestId,
        routeMethod: route.method,
        domain: result.domain || route.domain,
        confidence: route.confidence,
        tracker: latency,
        latencyTier: 'tier3_model_assisted',
        activeContext,
        route,
        routingDecision,
        existingMetadata: result.metadata && typeof result.metadata === 'object'
          ? result.metadata as Record<string, unknown>
          : null,
      });
      const response = buildChatHandlerResponseEnvelope({
        route,
        result: { ...result, text: enriched.text },
        buttons,
        metadata: enriched.metadata,
      });

      if (isNewUserFlow) {
        logger.debug(
          {
            chatRequestId,
            userId,
            domain: response.domain,
            routeMethod: response.routeMethod,
          hasButtons: Array.isArray(response.buttons) && response.buttons.length > 0,
          metadataType: (response.metadata as { type?: string } | null)?.type || null,
          textLength: response.text.length,
          },
          'iOS new-user chat response envelope',
        );
      }

      // Cache the response if it was a deterministic command
      maybeCacheChatCommandResponse(userId, normalizedTextLower, response, tenantId);

      persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
        clientMessageId: scopedClientMessageId,
        requestId: chatRequestId,
      });
      logger.info(
        {
          chatRequestId,
          tenantId,
          userId,
          domain: response.domain,
          durationMs: Date.now() - requestStartedAt,
        },
        'iOS chat request completed',
      );
      res.json(response);
    } catch (err: any) {
      const chatRequestId = getCurrentRequestId() || (req as any).requestId || `chat-${Date.now()}`;
      if (await sendRetryableChatFailureResponseIfNeeded({ err, res, userId, tenantId, normalizedText, chatRequestId })) return;
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
      // Release the per-user cost lock so the next concurrent request
      // from this user can run its own check → AI → spend cycle.
      releaseCostLock();
    }
  });
}
