// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const hoisted = vi.hoisted(() => ({
  runLocalChatTurn: vi.fn(),
  finalizeResponse: vi.fn(),
  persistExchange: vi.fn(),
  syncConversationState: vi.fn(),
  rememberActiveDomain: vi.fn(),
  recordChatStage: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../src/utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/logger')>()),
  logger: hoisted.logger,
}));

vi.mock('../../../src/api/routes/chat-message-shortcuts', () => ({
  isContentModelBackedChatShortcutRequest: vi.fn(() => false),
  resolveLocalPrimaryContentChatShortcutAdmission: vi.fn(() => null),
  tryBuildLocalPrimaryContentChatShortcutResponse: vi.fn(async () => null),
}));

vi.mock('../../../src/services/chat-core-v2', () => ({
  isLocalPrimaryChatUserEnrolled: vi.fn(() => true),
  loadChatV2MemoryContextForOrchestrator: vi.fn(() => null),
  runChatCoreV2LocalChatTurn: (...args: unknown[]) => hoisted.runLocalChatTurn(...args),
}));

vi.mock('../../../src/api/routes/chat-message-finalizer', () => ({
  finalizeChatMessageResponse: (...args: unknown[]) => hoisted.finalizeResponse(...args),
}));

vi.mock('../../../src/api/routes/chat-message-context', () => ({
  rememberChatActiveDomain: (...args: unknown[]) => hoisted.rememberActiveDomain(...args),
}));

vi.mock('../../../src/api/routes/chat-persistence', () => ({
  persistExchange: (...args: unknown[]) => hoisted.persistExchange(...args),
  syncConversationStateForShortcut: (...args: unknown[]) => hoisted.syncConversationState(...args),
}));

vi.mock('../../../src/services/chat-stage-trace', () => ({
  recordChatStage: (...args: unknown[]) => hoisted.recordChatStage(...args),
}));

vi.mock('../../../src/api/routes/chat-message-tier-gate', () => ({
  sendChatTierRequiredIfNeeded: vi.fn(() => false),
}));

vi.mock('../../../src/api/routes/chat-pipeline/support', () => ({
  buildRecentTurnsForChatCoreV2: vi.fn(() => []),
}));

vi.mock('../../../src/services/content-engine', () => ({
  ForwardedLocalInferenceError: class ForwardedLocalInferenceError extends Error {},
}));

vi.mock('../../../src/services/skill-inference-service', () => ({
  SkillInferencePolicyError: class SkillInferencePolicyError extends Error {},
}));

import { v2LocalAnswerStage } from '../../../src/api/routes/chat-pipeline/stages/v2-local-answer';
import type { ChatTurnCtx } from '../../../src/api/routes/chat-pipeline/types';

function visibleResponse(metadata: Record<string, unknown> = {}) {
  return {
    id: 'msg-visible',
    text: 'A complete visible answer.',
    domain: 'chat',
    routeMethod: 'chat-core-v2-local-llm',
    confidence: 0.9,
    buttons: null,
    metadata,
    timestamp: '2026-08-14T10:00:00.000Z',
    responseCards: [],
  };
}

function buildCtx(json: ReturnType<typeof vi.fn>): ChatTurnCtx {
  return {
    req: { header: () => undefined, body: {} } as unknown as Request,
    res: { json } as unknown as Response,
    userId: 42,
    tenantId: 84,
    normalizedText: 'Help me outline this idea.',
    normalizedTextLower: 'help me outline this idea.',
    normalizedAttachments: [],
    scopedClientMessageId: null,
    userMessageId: 'msg-user',
    requestStartedAt: 1_752_000_000_000,
    chatRequestId: 'req-v2-shadow',
    latency: { mark: vi.fn(), snapshot: vi.fn(() => ({})) } as unknown as ChatTurnCtx['latency'],
    ensureModelBudget: vi.fn(async () => true),
    isNewUserFlow: false,
    recordDeterministicReadEvidence: vi.fn(),
    recordChatV2CompletionEvidenceForImmediateResponse: vi.fn(),
    bypassReadFastPathsForWriteIntent: false,
    chatCoreV2RouteLocale: 'en-US',
    recordLegacyFallbackSample: vi.fn(),
    bypassNaturalLanguageTokenZeroForChatCoreV2: false,
    activeContext: null,
    preRoutingDecision: {} as never,
    turnContractEnabled: true,
    preTurnContract: { riskClass: 'low' } as never,
  } as ChatTurnCtx;
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.runLocalChatTurn.mockImplementation(async (input: {
    deferShadowUntilVisibleOwner: (scheduleShadow: () => void) => void;
  }) => {
    input.deferShadowUntilVisibleOwner(vi.fn());
    return {
      response: visibleResponse(),
      modelMetadata: { providerUsed: 'ollama', modelUsed: 'pinned-local' },
      degraded: false,
    };
  });
  hoisted.finalizeResponse.mockImplementation((response: ReturnType<typeof visibleResponse>) => ({
    ...response,
    metadata: {
      ...response.metadata,
      chatReasoning: { fallbackUsed: false },
      finalAnswerComposition: { ok: true },
      responseQuality: { status: 'pass' },
    },
  }));
});

describe('chat_core_v2_local_answer shadow publication boundary', () => {
  it('releases the detached shadow only after the eligible visible response is published', async () => {
    const order: string[] = [];
    const scheduleShadow = vi.fn(() => order.push('shadow'));
    hoisted.runLocalChatTurn.mockImplementationOnce(async (input: {
      deferShadowUntilVisibleOwner: (schedule: () => void) => void;
    }) => {
      input.deferShadowUntilVisibleOwner(scheduleShadow);
      return {
        response: visibleResponse(),
        modelMetadata: { providerUsed: 'ollama', modelUsed: 'pinned-local' },
        degraded: false,
      };
    });
    const json = vi.fn(() => order.push('visible_response'));

    await expect(v2LocalAnswerStage.handle(buildCtx(json))).resolves.toEqual({ kind: 'respond' });

    expect(order).toEqual(['visible_response', 'shadow']);
    expect(scheduleShadow).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['quality repair', { responseQuality: { status: 'repaired' }, finalAnswerComposition: { ok: true }, chatReasoning: { fallbackUsed: false } }],
    ['composition rejection', { responseQuality: { status: 'pass' }, finalAnswerComposition: { ok: false }, chatReasoning: { fallbackUsed: false } }],
    ['fallback answer', { responseQuality: { status: 'pass' }, finalAnswerComposition: { ok: true }, chatReasoning: { fallbackUsed: true } }],
    ['language repair', { responseQuality: { status: 'pass' }, finalAnswerComposition: { ok: true }, chatReasoning: { fallbackUsed: false }, responseLanguageGuard: { repaired: true } }],
  ])('discards the detached shadow after a final %s', async (_label, metadata) => {
    const scheduleShadow = vi.fn();
    hoisted.runLocalChatTurn.mockImplementationOnce(async (input: {
      deferShadowUntilVisibleOwner: (schedule: () => void) => void;
    }) => {
      input.deferShadowUntilVisibleOwner(scheduleShadow);
      return {
        response: visibleResponse(),
        modelMetadata: { providerUsed: 'ollama', modelUsed: 'pinned-local' },
        degraded: false,
      };
    });
    hoisted.finalizeResponse.mockReturnValueOnce(visibleResponse(metadata));
    const json = vi.fn();

    await v2LocalAnswerStage.handle(buildCtx(json));

    expect(json).toHaveBeenCalledTimes(1);
    expect(scheduleShadow).not.toHaveBeenCalled();
  });

  it('does not release the shadow when response publication throws', async () => {
    const scheduleShadow = vi.fn();
    hoisted.runLocalChatTurn.mockImplementationOnce(async (input: {
      deferShadowUntilVisibleOwner: (schedule: () => void) => void;
    }) => {
      input.deferShadowUntilVisibleOwner(scheduleShadow);
      return {
        response: visibleResponse(),
        modelMetadata: { providerUsed: 'ollama', modelUsed: 'pinned-local' },
        degraded: false,
      };
    });
    const publicationFailure = new Error('response publication failed');
    const json = vi.fn(() => { throw publicationFailure; });

    await expect(v2LocalAnswerStage.handle(buildCtx(json))).rejects.toBe(publicationFailure);

    expect(scheduleShadow).not.toHaveBeenCalled();
  });
});
