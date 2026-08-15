/**
 * M18 — legacy-tail timeout catch: checkpoint-aware partial-progress terminal.
 *
 * Spike verdict: never resume an open provider tool loop across a process
 * boundary. The background job consumes only the detached foreground result;
 * rejection or deadline fails honestly and never starts another provider turn.
 * The stage therefore:
 *   - checkpoints > 0 → deterministic locale-aware partial-progress reply
 *     naming the completed tools (finalizer 'legacy_timeout_partial',
 *     contract_only family), HTTP 202, durable background continuation + APNs;
 *   - checkpoints == 0 → rethrow, keeping the pre-M18 degraded behavior
 *     byte-identical at the route catch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const hoisted = vi.hoisted(() => ({
  executeChatDomainHandler: vi.fn(),
  routeMessage: vi.fn(),
  finalizeChatAnswerMetadata: vi.fn(),
  persistExchange: vi.fn(),
  runWithChatToolAuthorization: vi.fn(),
  enqueueBackgroundChatCommand: vi.fn(),
  analyzeChatSkillOrchestration: vi.fn(),
  getPendingChatConfirmation: vi.fn(),
  clearPendingChatConfirmation: vi.fn(),
  rememberChatActiveDomain: vi.fn(),
  syncConversationStateForShortcut: vi.fn(),
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../../src/router', async () => ({
  ...(await vi.importActual('../../../src/router')),
  routeMessage: (...args: unknown[]) => hoisted.routeMessage(...args as []),
}));

vi.mock('../../../src/services/chat-pending-confirmations', async () => ({
  ...(await vi.importActual('../../../src/services/chat-pending-confirmations')),
  getPendingChatConfirmation: (...args: unknown[]) => hoisted.getPendingChatConfirmation(...args as []),
  clearPendingChatConfirmation: (...args: unknown[]) => hoisted.clearPendingChatConfirmation(...args as []),
}));

vi.mock('../../../src/services/chat-skill-orchestrator', async () => ({
  ...(await vi.importActual('../../../src/services/chat-skill-orchestrator')),
  analyzeChatSkillOrchestration: (...args: unknown[]) => hoisted.analyzeChatSkillOrchestration(...args as []),
  applyChatSkillRoutingDecision: vi.fn((route: unknown) => route),
  buildChatSkillRoutingLogContext: vi.fn(() => ({})),
}));

vi.mock('../../../src/services/chat-tool-authorization', async () => ({
  ...(await vi.importActual('../../../src/services/chat-tool-authorization')),
  runWithChatToolAuthorization: (...args: unknown[]) => hoisted.runWithChatToolAuthorization(...args as []),
}));

vi.mock('../../../src/services/content-workspace-chat-consent', async () => ({
  ...(await vi.importActual('../../../src/services/content-workspace-chat-consent')),
  issueContentIdeaCaptureConsent: vi.fn(() => null),
}));

vi.mock('../../../src/api/routes/chat-message-context', async () => ({
  ...(await vi.importActual('../../../src/api/routes/chat-message-context')),
  buildDefaultButtonsForChatDomain: vi.fn(() => null),
  getChatDomainHandler: vi.fn(() => vi.fn()),
  rememberChatActiveDomain: (...args: unknown[]) => hoisted.rememberChatActiveDomain(...args),
}));

vi.mock('../../../src/api/routes/chat-message-execution', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    executeChatDomainHandler: (...args: unknown[]) => hoisted.executeChatDomainHandler(...args as []),
  };
});

vi.mock('../../../src/api/routes/chat-message-finalizer', async () => ({
  ...(await vi.importActual('../../../src/api/routes/chat-message-finalizer')),
  finalizeChatAnswerMetadata: (...args: unknown[]) => hoisted.finalizeChatAnswerMetadata(...args as []),
  finalizeChatMessageResponse: vi.fn((response: unknown) => response),
}));

vi.mock('../../../src/api/routes/chat-message-local-responses', async () => ({
  ...(await vi.importActual('../../../src/api/routes/chat-message-local-responses')),
  maybeCacheChatCommandResponse: vi.fn(),
}));

vi.mock('../../../src/api/routes/chat-message-tier-gate', () => ({
  sendChatTierRequiredIfNeeded: vi.fn(() => false),
}));

vi.mock('../../../src/api/routes/chat-persistence', async () => ({
  ...(await vi.importActual('../../../src/api/routes/chat-persistence')),
  persistExchange: (...args: unknown[]) => hoisted.persistExchange(...args as []),
  syncConversationStateForShortcut: (...args: unknown[]) => hoisted.syncConversationStateForShortcut(...args),
}));

vi.mock('../../../src/api/routes/chat-message-shortcuts', async () => ({
  ...(await vi.importActual('../../../src/api/routes/chat-message-shortcuts')),
  tryBuildChatMessageShortcutResponse: vi.fn(async () => null),
}));

vi.mock('../../../src/services/chat-stage-trace', async () => ({
  ...(await vi.importActual('../../../src/services/chat-stage-trace')),
  recordChatStage: vi.fn(),
}));

vi.mock('../../../src/api/routes/chat-pipeline/support', async () => ({
  ...(await vi.importActual('../../../src/api/routes/chat-pipeline/support')),
  applyTurnContractRouteHint: vi.fn((route: unknown) => route),
}));

// M18 queued-continuation contract: the timeout error carries the job that was
// durably enqueued by executeChatDomainHandler before it rejected.
vi.mock('../../../src/services/chat-core-v2/background-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    enqueueBackgroundChatCommand: (...args: unknown[]) => hoisted.enqueueBackgroundChatCommand(...args as []),
  };
});

import { legacyTailStage } from '../../../src/api/routes/chat-pipeline/stages/legacy-tail';
import { ChatDomainTimeoutError } from '../../../src/api/routes/chat-message-execution';
import type { ChatTurnCtx } from '../../../src/api/routes/chat-pipeline/types';
import { markChatShadowBaselineEligible } from '../../../src/services/chat-shadow-baseline';

function buildCtx(overrides: Partial<ChatTurnCtx> & Record<string, unknown> = {}): { ctx: ChatTurnCtx; json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const ctx = {
    req: { header: () => undefined, body: {} } as unknown as Request,
    res: { json, status } as unknown as Response,
    userId: 42,
    tenantId: 42,
    normalizedText: 'plan my day',
    normalizedTextLower: 'plan my day',
    normalizedAttachments: [],
    scopedClientMessageId: null,
    userMessageId: 'msg-user-1',
    requestStartedAt: 1_752_000_000_000,
    chatRequestId: 'req-m18',
    latency: { mark: vi.fn(), snapshot: vi.fn(() => ({})) } as unknown as ChatTurnCtx['latency'],
    ensureModelBudget: vi.fn(async () => true),
    chatCoreV2RouteLocale: 'en-US',
    recordLegacyFallbackSample: vi.fn(),
    activeContext: null,
    preTurnContract: null,
    isNewUserFlow: false,
    ...overrides,
  } as unknown as ChatTurnCtx;
  return { ctx, json, status };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.analyzeChatSkillOrchestration.mockReturnValue({
    safety: { explicitConfirmation: false, requiresConfirmation: false },
    involvedSkills: [],
  });
  hoisted.getPendingChatConfirmation.mockReturnValue(null);
  hoisted.routeMessage.mockResolvedValue({
    domain: 'secretary',
    method: 'ai',
    confidence: 0.9,
    strippedMessage: 'plan my day',
  });
  hoisted.runWithChatToolAuthorization.mockImplementation(
    async (_opts: unknown, fn: () => Promise<unknown>) => fn(),
  );
  hoisted.finalizeChatAnswerMetadata.mockImplementation((input: { responseText: string; existingMetadata?: Record<string, unknown> | null }) => ({
    text: input.responseText,
    metadata: {
      ...(input.existingMetadata ?? {}),
      finalized: true,
      chatReasoning: { fallbackUsed: false },
      finalAnswerComposition: { ok: true },
      responseQuality: { status: 'pass' },
    },
    contract: {},
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('legacy_tail M18 timeout catch', () => {
  it('threads client cancellation through routing and the legacy domain handler without persisting a reply', async () => {
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('client disconnected'), {
      name: 'AbortError',
      code: 'CHAT_REQUEST_CANCELLED',
    });
    hoisted.executeChatDomainHandler.mockImplementation(async (...args: unknown[]) => {
      expect(args[7]).toMatchObject({ abortSignal: controller.signal });
      controller.abort(cancellation);
      throw cancellation;
    });
    const { ctx, json } = buildCtx({ abortSignal: controller.signal });

    await expect(legacyTailStage.handle(ctx)).rejects.toBe(cancellation);

    expect(hoisted.routeMessage).toHaveBeenCalledWith(
      'plan my day',
      null,
      42,
      42,
      controller.signal,
    );
    expect(hoisted.persistExchange).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    ['clarify', 'routing-clarify', 'needs_clarification'],
    ['none', 'unsupported', 'blocked'],
  ] as const)('terminates an explicit classifier %s result before orchestration or domain execution', async (
    disposition,
    routeMethod,
    actionStatus,
  ) => {
    hoisted.routeMessage.mockResolvedValue({
      domain: 'chat',
      method: 'classifier',
      confidence: 0.93,
      strippedMessage: 'do the ambiguous thing',
      disposition,
    });

    const { ctx, json } = buildCtx({ normalizedText: 'do the ambiguous thing' });
    const result = await legacyTailStage.handle(ctx);

    expect(result).toEqual({ kind: 'respond' });
    expect(json).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0][0]).toMatchObject({
      domain: 'chat',
      routeMethod,
      metadata: {
        type: 'chat_manifest_classifier_terminal',
        disposition,
        actionStatus,
      },
    });
    expect(hoisted.analyzeChatSkillOrchestration).not.toHaveBeenCalled();
    expect(hoisted.runWithChatToolAuthorization).not.toHaveBeenCalled();
    expect(hoisted.executeChatDomainHandler).not.toHaveBeenCalled();
    expect(hoisted.persistExchange).toHaveBeenCalledTimes(1);
    expect(hoisted.rememberChatActiveDomain).not.toHaveBeenCalled();
    expect(hoisted.syncConversationStateForShortcut).not.toHaveBeenCalled();
  });

  it('turns a checkpointed timeout into an honest queued partial-progress 202 naming tools 1-2', async () => {
    const timeoutError = new ChatDomainTimeoutError('req-m18', [
      { toolName: 'ms_todo_get_tasks', sequence: 1, completedAt: '2026-07-21T10:00:00.000Z' },
      { toolName: 'get_calendar_events', sequence: 2, completedAt: '2026-07-21T10:00:01.000Z' },
    ], { jobId: 'job-m18', notificationPolicy: 'apns' });
    hoisted.executeChatDomainHandler.mockRejectedValue(timeoutError);

    const { ctx, json, status } = buildCtx();
    const result = await legacyTailStage.handle(ctx);

    expect(result).toEqual({ kind: 'respond' });
    expect(json).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(202);
    const envelope = json.mock.calls[0][0] as { text: string; metadata: Record<string, unknown> };
    // The deterministic template names exactly the completed tools.
    expect(envelope.text).toContain('ms todo get tasks');
    expect(envelope.text).toContain('get calendar events');
    expect(envelope.text).toContain('whether it completes or stops');

    // Finalized through the contract_only partial family with honest tags.
    expect(hoisted.finalizeChatAnswerMetadata).toHaveBeenCalledTimes(1);
    const finalizeInput = hoisted.finalizeChatAnswerMetadata.mock.calls[0][0] as Record<string, unknown>;
    expect(finalizeInput.stageFamily).toBe('legacy_timeout_partial');
    expect(finalizeInput.actionability).toBe('answer_only');
    expect(finalizeInput.verificationStatus).toBe('partial_failure');
    const existingMetadata = finalizeInput.existingMetadata as Record<string, unknown>;
    expect(existingMetadata.type).toBe('chat_timeout_partial');
    expect(existingMetadata.timeoutPartial).toMatchObject({
      runId: 'req-m18',
      autoResume: false,
      continuation: 'background_queue',
      continuationJobId: 'job-m18',
      notificationPolicy: 'apns',
      destructiveResumePolicy: 'reconfirm',
      completedTools: ['ms_todo_get_tasks', 'get_calendar_events'],
    });

    // The route never misuses the write-command queue; the typed timeout
    // already carries the dedicated continuation job reference.
    expect(hoisted.enqueueBackgroundChatCommand).not.toHaveBeenCalled();
    // The exchange persists so the client sees a completed turn.
    expect(hoisted.persistExchange).toHaveBeenCalledTimes(1);
  });

  it('rethrows a zero-checkpoint timeout so the pre-M18 degraded behavior stays unchanged', async () => {
    const timeoutError = new ChatDomainTimeoutError('req-m18', []);
    hoisted.executeChatDomainHandler.mockRejectedValue(timeoutError);

    const { ctx, json } = buildCtx();
    await expect(legacyTailStage.handle(ctx)).rejects.toBe(timeoutError);
    expect(json).not.toHaveBeenCalled();
    expect(hoisted.persistExchange).not.toHaveBeenCalled();
    expect(hoisted.enqueueBackgroundChatCommand).not.toHaveBeenCalled();
  });

  it('propagates non-timeout errors untouched', async () => {
    const boom = new Error('provider exploded');
    hoisted.executeChatDomainHandler.mockRejectedValue(boom);
    const pendingLocalPrimaryChatShadow = vi.fn();

    const { ctx, json } = buildCtx({ pendingLocalPrimaryChatShadow });
    await expect(legacyTailStage.handle(ctx)).rejects.toBe(boom);
    expect(json).not.toHaveBeenCalled();
    expect(pendingLocalPrimaryChatShadow).not.toHaveBeenCalled();
  });

  it('releases a deferred local shadow only after publishing an eligible visible model answer', async () => {
    const order: string[] = [];
    const pendingLocalPrimaryChatShadow = vi.fn(() => order.push('shadow'));
    hoisted.executeChatDomainHandler.mockResolvedValue(markChatShadowBaselineEligible({
      text: 'A complete cloud-owned answer.',
      domain: 'secretary',
    }, true));

    const { ctx, json } = buildCtx({ pendingLocalPrimaryChatShadow });
    json.mockImplementation(() => {
      order.push('visible_response');
    });
    await legacyTailStage.handle(ctx);

    expect(order).toEqual(['visible_response', 'shadow']);
    expect(pendingLocalPrimaryChatShadow).toHaveBeenCalledTimes(1);
    expect(ctx.pendingLocalPrimaryChatShadow).toBeNull();
  });

  it('discards a deferred local shadow when the visible terminal is deterministic or degraded', async () => {
    const pendingLocalPrimaryChatShadow = vi.fn();
    hoisted.executeChatDomainHandler.mockResolvedValue({
      text: 'AI is temporarily unavailable.',
      domain: 'secretary',
    });

    const { ctx, json } = buildCtx({ pendingLocalPrimaryChatShadow });
    await legacyTailStage.handle(ctx);

    expect(json).toHaveBeenCalledTimes(1);
    expect(pendingLocalPrimaryChatShadow).not.toHaveBeenCalled();
    expect(ctx.pendingLocalPrimaryChatShadow).toBeNull();
  });

  it('discards a deferred local shadow when final validation repairs the visible model answer', async () => {
    const pendingLocalPrimaryChatShadow = vi.fn();
    hoisted.executeChatDomainHandler.mockResolvedValue(markChatShadowBaselineEligible({
      text: 'I published the requested item.',
      domain: 'secretary',
    }, true));
    hoisted.finalizeChatAnswerMetadata.mockReturnValueOnce({
      text: 'I could not verify that action.',
      metadata: {
        chatReasoning: { fallbackUsed: true },
        finalAnswerComposition: { ok: false },
        responseQuality: { status: 'repaired' },
      },
      contract: {},
    });

    const { ctx, json } = buildCtx({ pendingLocalPrimaryChatShadow });
    await legacyTailStage.handle(ctx);

    expect(json).toHaveBeenCalledTimes(1);
    expect(pendingLocalPrimaryChatShadow).not.toHaveBeenCalled();
    expect(ctx.pendingLocalPrimaryChatShadow).toBeNull();
  });

  it('consumes the staged destructive confirmation on timeout so any later recovery must re-confirm', async () => {
    // The detached original turn retains its in-memory, per-target single-use
    // authorization. The durable staged grant must still be consumed here:
    // if that original turn definitively fails, a later recovery is a new
    // attempt and must not inherit the old destructive authorization.
    hoisted.analyzeChatSkillOrchestration.mockReturnValue({
      safety: { explicitConfirmation: true, requiresConfirmation: true },
      involvedSkills: [],
    });
    hoisted.getPendingChatConfirmation.mockReturnValue({
      confirmedTargets: [{ tool: 'delete_task', target: 't-1' }],
    });
    const timeoutError = new ChatDomainTimeoutError('req-m18', [
      { toolName: 'ms_todo_get_tasks', sequence: 1, completedAt: '2026-07-21T10:00:00.000Z' },
    ]);
    hoisted.executeChatDomainHandler.mockRejectedValue(timeoutError);

    const { ctx, json } = buildCtx();
    await legacyTailStage.handle(ctx);

    expect(json).toHaveBeenCalledTimes(1);
    expect(hoisted.clearPendingChatConfirmation).toHaveBeenCalledTimes(1);
    expect(hoisted.clearPendingChatConfirmation).toHaveBeenCalledWith(42, 42);
  });

  it('still clears the staged confirmation when the confirmed turn completes normally', async () => {
    hoisted.analyzeChatSkillOrchestration.mockReturnValue({
      safety: { explicitConfirmation: true, requiresConfirmation: true },
      involvedSkills: [],
    });
    hoisted.getPendingChatConfirmation.mockReturnValue({
      confirmedTargets: [{ tool: 'delete_task', target: 't-1' }],
    });
    hoisted.executeChatDomainHandler.mockResolvedValue({ text: 'deleted', domain: 'secretary' });

    const { ctx } = buildCtx();
    await legacyTailStage.handle(ctx);

    expect(hoisted.clearPendingChatConfirmation).toHaveBeenCalledTimes(1);
    expect(hoisted.clearPendingChatConfirmation).toHaveBeenCalledWith(42, 42);
  });

  it('propagates the exact staged targets into the live legacy authorization scope', async () => {
    const authorization = await vi.importActual<typeof import('../../../src/services/chat-tool-authorization')>(
      '../../../src/services/chat-tool-authorization',
    );
    hoisted.analyzeChatSkillOrchestration.mockReturnValue({
      safety: { explicitConfirmation: true, requiresConfirmation: true },
      involvedSkills: [],
    });
    hoisted.getPendingChatConfirmation.mockReturnValue({
      confirmedTargets: [{ tool: 'delete_calendar_event', targetId: 'evt-A' }],
    });
    hoisted.runWithChatToolAuthorization.mockImplementation(
      async (context: Parameters<typeof authorization.runWithChatToolAuthorization>[0], fn: () => Promise<unknown>) =>
        authorization.runWithChatToolAuthorization(context, fn),
    );
    hoisted.executeChatDomainHandler.mockImplementation(async () => {
      const wrongTarget = authorization.authorizeChatToolCall(
        'delete_calendar_event',
        { event_id: 'evt-B' },
        42,
        42,
      );
      const stagedTarget = authorization.authorizeChatToolCall(
        'delete_calendar_event',
        { event_id: 'evt-A' },
        42,
        42,
      );
      return {
        text: 'authorization checked',
        domain: 'secretary',
        metadata: { wrongTarget, stagedTarget },
      };
    });

    const { ctx, json } = buildCtx();
    await legacyTailStage.handle(ctx);

    const envelope = json.mock.calls[0][0] as {
      metadata: {
        wrongTarget: { allowed: boolean; code?: string };
        stagedTarget: { allowed: boolean };
      };
    };
    expect(envelope.metadata.wrongTarget).toMatchObject({
      allowed: false,
      code: 'CONFIRMATION_REQUIRED',
    });
    expect(envelope.metadata.stagedTarget).toMatchObject({ allowed: true });
    expect(hoisted.runWithChatToolAuthorization.mock.calls[0]?.[0]).toMatchObject({
      userId: 42,
      tenantId: 42,
      confirmedDestructiveTargets: [{ tool: 'delete_calendar_event', targetId: 'evt-A' }],
    });
  });

  it('stages zero destructive grants when explicit text has no server-side target set', async () => {
    hoisted.analyzeChatSkillOrchestration.mockReturnValue({
      safety: { explicitConfirmation: true, requiresConfirmation: true },
      involvedSkills: [],
    });
    hoisted.getPendingChatConfirmation.mockReturnValue(null);
    hoisted.executeChatDomainHandler.mockResolvedValue({ text: 'no mutation', domain: 'secretary' });

    const { ctx } = buildCtx();
    await legacyTailStage.handle(ctx);

    expect(hoisted.runWithChatToolAuthorization.mock.calls[0]?.[0]).toMatchObject({
      confirmedDestructiveAction: true,
      confirmedDestructiveTargets: [],
      confirmationSource: 'explicit_current_turn',
    });
  });

  it('localizes the partial-progress template for pt locales', async () => {
    const timeoutError = new ChatDomainTimeoutError('req-m18', [
      { toolName: 'search_notes', sequence: 1, completedAt: '2026-07-21T10:00:00.000Z' },
    ]);
    hoisted.executeChatDomainHandler.mockRejectedValue(timeoutError);

    const { ctx, json } = buildCtx({ chatCoreV2RouteLocale: 'pt-PT' });
    await legacyTailStage.handle(ctx);

    const envelope = json.mock.calls[0][0] as { text: string };
    expect(envelope.text).toContain('search notes');
    expect(envelope.text).toContain('continuar');
  });
});
