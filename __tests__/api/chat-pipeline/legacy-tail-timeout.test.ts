/**
 * M18 — legacy-tail timeout catch: checkpoint-aware partial-progress terminal.
 *
 * Spike verdict: no auto-resume for the legacy tool loop (detached loop keeps
 * running after Promise.race; ADV-2 provider pinning + sliced-history shape
 * stability cannot be guaranteed across the process boundary; checkpoints are
 * sanitized summaries, not verbatim provider turns). The stage therefore:
 *   - checkpoints > 0 → deterministic locale-aware partial-progress reply
 *     naming the completed tools (finalizer 'legacy_timeout_partial',
 *     contract_only family), honest "ask me to continue", NO background
 *     continuation enqueued;
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
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../../src/router', () => ({
  routeMessage: (...args: unknown[]) => hoisted.routeMessage(...args as []),
}));

vi.mock('../../../src/services/chat-pending-confirmations', () => ({
  getPendingChatConfirmation: (...args: unknown[]) => hoisted.getPendingChatConfirmation(...args as []),
  clearPendingChatConfirmation: (...args: unknown[]) => hoisted.clearPendingChatConfirmation(...args as []),
}));

vi.mock('../../../src/services/chat-skill-orchestrator', () => ({
  analyzeChatSkillOrchestration: (...args: unknown[]) => hoisted.analyzeChatSkillOrchestration(...args as []),
  applyChatSkillRoutingDecision: vi.fn((route: unknown) => route),
  buildChatSkillRoutingLogContext: vi.fn(() => ({})),
}));

vi.mock('../../../src/services/chat-tool-authorization', () => ({
  runWithChatToolAuthorization: (...args: unknown[]) => hoisted.runWithChatToolAuthorization(...args as []),
}));

vi.mock('../../../src/services/content-workspace-chat-consent', () => ({
  issueContentIdeaCaptureConsent: vi.fn(() => null),
}));

vi.mock('../../../src/api/routes/chat-message-context', () => ({
  buildDefaultButtonsForChatDomain: vi.fn(() => null),
  getChatDomainHandler: vi.fn(() => vi.fn()),
  rememberChatActiveDomain: vi.fn(),
}));

vi.mock('../../../src/api/routes/chat-message-execution', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    executeChatDomainHandler: (...args: unknown[]) => hoisted.executeChatDomainHandler(...args as []),
  };
});

vi.mock('../../../src/api/routes/chat-message-finalizer', () => ({
  finalizeChatAnswerMetadata: (...args: unknown[]) => hoisted.finalizeChatAnswerMetadata(...args as []),
  finalizeChatMessageResponse: vi.fn((response: unknown) => response),
}));

vi.mock('../../../src/api/routes/chat-message-local-responses', () => ({
  maybeCacheChatCommandResponse: vi.fn(),
}));

vi.mock('../../../src/api/routes/chat-message-tier-gate', () => ({
  sendChatTierRequiredIfNeeded: vi.fn(() => false),
}));

vi.mock('../../../src/api/routes/chat-persistence', () => ({
  persistExchange: (...args: unknown[]) => hoisted.persistExchange(...args as []),
  syncConversationStateForShortcut: vi.fn(),
}));

vi.mock('../../../src/api/routes/chat-message-shortcuts', () => ({
  tryBuildChatMessageShortcutResponse: vi.fn(async () => null),
}));

vi.mock('../../../src/services/chat-stage-trace', () => ({
  recordChatStage: vi.fn(),
}));

vi.mock('../../../src/api/routes/chat-pipeline/support', () => ({
  applyTurnContractRouteHint: vi.fn((route: unknown) => route),
}));

// M18 no-auto-resume guard: the background queue must never be touched by
// the legacy timeout path.
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
    metadata: { ...(input.existingMetadata ?? {}), finalized: true },
    contract: {},
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('legacy_tail M18 timeout catch', () => {
  it('turns a checkpointed timeout into an honest partial-progress reply naming tools 1-2 (no auto-resume)', async () => {
    const timeoutError = new ChatDomainTimeoutError('req-m18', [
      { toolName: 'ms_todo_get_tasks', sequence: 1, completedAt: '2026-07-21T10:00:00.000Z' },
      { toolName: 'get_calendar_events', sequence: 2, completedAt: '2026-07-21T10:00:01.000Z' },
    ]);
    hoisted.executeChatDomainHandler.mockRejectedValue(timeoutError);

    const { ctx, json } = buildCtx();
    const result = await legacyTailStage.handle(ctx);

    expect(result).toEqual({ kind: 'respond' });
    expect(json).toHaveBeenCalledTimes(1);
    const envelope = json.mock.calls[0][0] as { text: string; metadata: Record<string, unknown> };
    // The deterministic template names exactly the completed tools.
    expect(envelope.text).toContain('ms todo get tasks');
    expect(envelope.text).toContain('get calendar events');
    expect(envelope.text.toLowerCase()).toContain('continue');

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
      completedTools: ['ms_todo_get_tasks', 'get_calendar_events'],
    });

    // Honest partial means NO queued continuation.
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

    const { ctx, json } = buildCtx();
    await expect(legacyTailStage.handle(ctx)).rejects.toBe(boom);
    expect(json).not.toHaveBeenCalled();
  });

  it('preserves the staged destructive confirmation on a timeout partial — nothing executed, so the retry keeps the grant', async () => {
    // Adversarial NIT (M18 remediation, 2026-07-21): the confirmed turn
    // timed out before any destructive tool ran, yet the stage cleared the
    // staged confirmation — a retry then demanded a re-confirmation for work
    // that never happened. The timeout-partial path must leave the staged
    // confirmation in place.
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
    expect(hoisted.clearPendingChatConfirmation).not.toHaveBeenCalled();
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
