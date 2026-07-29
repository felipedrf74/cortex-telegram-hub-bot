// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockBuildAITemporarilyBusyResponse = vi.fn();
const mockKeywordMatch = vi.fn();
const mockGetLastChatActiveDomain = vi.fn();
const mockIsRetryableAIProviderError = vi.fn();
const mockPersistExchange = vi.fn();
const mockSyncConversationStateForShortcut = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('../../src/domains/ai-unavailable', () => ({
  buildAITemporarilyBusyResponse: (...args: unknown[]) => mockBuildAITemporarilyBusyResponse(...args),
}));

vi.mock('../../src/router', () => ({
  keywordMatch: (...args: unknown[]) => mockKeywordMatch(...args),
}));

vi.mock('../../src/api/routes/chat-message-context', () => ({
  getLastChatActiveDomain: (...args: unknown[]) => mockGetLastChatActiveDomain(...args),
}));

vi.mock('../../src/api/routes/chat-content-refinement', async () => ({
  ...(await vi.importActual('../../src/api/routes/chat-content-refinement')),
  isRetryableAIProviderError: (...args: unknown[]) => mockIsRetryableAIProviderError(...args),
}));

vi.mock('../../src/api/routes/chat-persistence', () => ({
  persistExchange: (...args: unknown[]) => mockPersistExchange(...args),
  syncConversationStateForShortcut: (...args: unknown[]) => mockSyncConversationStateForShortcut(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { sendRetryableChatFailureResponseIfNeeded } from '../../src/api/routes/chat-message-degraded-response';

function mockRes() {
  const response: any = {
    body: undefined,
    json: vi.fn((body: unknown) => {
      response.body = body;
      return response;
    }),
  };
  return response;
}

describe('chat message degraded response', () => {
  beforeEach(() => {
    mockBuildAITemporarilyBusyResponse.mockReset();
    mockKeywordMatch.mockReset();
    mockGetLastChatActiveDomain.mockReset();
    mockIsRetryableAIProviderError.mockReset();
    mockPersistExchange.mockReset();
    mockSyncConversationStateForShortcut.mockReset();
    mockLoggerWarn.mockReset();

    mockIsRetryableAIProviderError.mockReturnValue(true);
    mockKeywordMatch.mockReturnValue(null);
    mockGetLastChatActiveDomain.mockReturnValue(null);
    mockBuildAITemporarilyBusyResponse.mockResolvedValue({
      text: 'Estou temporariamente sem o modelo principal. Tenta novamente em instantes.',
      domain: 'secretary',
    });
  });

  it('does nothing for non-retryable failures', async () => {
    mockIsRetryableAIProviderError.mockReturnValue(false);

    const res = mockRes();
    const handled = await sendRetryableChatFailureResponseIfNeeded({
      err: new Error('bad request'),
      res,
      userId: 42,
      normalizedText: 'olá',
      chatRequestId: 'chat-1',
    });

    expect(handled).toBe(false);
    expect(mockBuildAITemporarilyBusyResponse).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('uses keyword routing before active context when choosing the degraded domain', async () => {
    const err = new Error('overloaded');
    mockKeywordMatch.mockReturnValue('finance');
    mockGetLastChatActiveDomain.mockReturnValue('content');
    mockBuildAITemporarilyBusyResponse.mockResolvedValue({
      text: 'O assistente financeiro está temporariamente indisponível.',
      domain: 'finance',
    });

    const res = mockRes();
    const handled = await sendRetryableChatFailureResponseIfNeeded({
      err,
      res,
      userId: 42,
      tenantId: 420,
      normalizedText: 'quanto gastei este mês?',
      chatRequestId: 'chat-2',
    });

    expect(handled).toBe(true);
    expect(mockBuildAITemporarilyBusyResponse).toHaveBeenCalledWith('finance', 42, 420);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { err, platform: 'ios', chatRequestId: 'chat-2', userId: 42, degradedDomain: 'finance' },
      'iOS chat/message degraded after retryable AI provider failure',
    );
    expect(res.body).toMatchObject({
      text: 'O assistente financeiro está temporariamente indisponível.',
      domain: 'finance',
      routeMethod: 'degraded',
      confidence: 0.1,
      buttons: null,
      metadata: { degraded: true, retryable: true },
    });
    expect(res.body.id).toMatch(/^msg-/);
    expect(res.body.timestamp).toEqual(expect.any(String));
    expect(mockPersistExchange).toHaveBeenCalledWith(
      42,
      expect.stringMatching(/^msg-user-/),
      'quanto gastei este mês?',
      expect.stringMatching(/^msg-/),
      expect.objectContaining({ domain: 'finance', routeMethod: 'degraded' }),
      420,
    );
    expect(mockSyncConversationStateForShortcut).toHaveBeenCalledWith(
      42,
      'finance',
      'quanto gastei este mês?',
      'O assistente financeiro está temporariamente indisponível.',
      420,
    );
  });

  it('falls back to active context, then Secretary, when keyword routing has no match', async () => {
    mockGetLastChatActiveDomain.mockReturnValueOnce('content').mockReturnValueOnce(null);

    const firstRes = mockRes();
    await sendRetryableChatFailureResponseIfNeeded({
      err: new Error('timeout'),
      res: firstRes,
      userId: 42,
      tenantId: 420,
      normalizedText: 'faz mais curto',
      chatRequestId: 'chat-3',
    });

    const secondRes = mockRes();
    await sendRetryableChatFailureResponseIfNeeded({
      err: new Error('timeout'),
      res: secondRes,
      userId: 42,
      tenantId: 420,
      normalizedText: 'faz isto',
      chatRequestId: 'chat-4',
    });

    expect(mockBuildAITemporarilyBusyResponse).toHaveBeenNthCalledWith(1, 'content', 42, 420);
    expect(mockBuildAITemporarilyBusyResponse).toHaveBeenNthCalledWith(2, 'secretary', 42, 420);
  });

  // ─────────────────────────────────────────────────────────────────────
  // QA regression pins (skill-hardening 2026-05-18 follow-up, P3-1):
  // The previous QA flagged that the test only assertions a positive-path
  // tenantId, so a regression that replaced `validatedTenantId` with
  // `tenantId ?? userId` would slip through. These tests pin the actual
  // throw path on missing/invalid tenantId.
  // ─────────────────────────────────────────────────────────────────────

  it('throws TenantScopeError when tenantId is undefined (no silent fallback)', async () => {
    const err = new Error('overloaded');
    const res = mockRes();
    await expect(sendRetryableChatFailureResponseIfNeeded({
      err,
      res,
      userId: 42,
      // tenantId intentionally omitted
      normalizedText: 'olá',
      chatRequestId: 'chat-missing-tenant',
    })).rejects.toMatchObject({
      name: 'TenantScopeError',
      code: 'TENANT_SCOPE_REQUIRED',
      status: 400,
    });

    // Neither persistence helper should have been invoked.
    expect(mockPersistExchange).not.toHaveBeenCalled();
    expect(mockSyncConversationStateForShortcut).not.toHaveBeenCalled();
    // No degraded body should have been sent.
    expect(res.json).not.toHaveBeenCalled();
  });

  it('throws TenantScopeError when tenantId is 0 (invalid positive-integer check)', async () => {
    const err = new Error('overloaded');
    const res = mockRes();
    await expect(sendRetryableChatFailureResponseIfNeeded({
      err,
      res,
      userId: 42,
      tenantId: 0,
      normalizedText: 'olá',
      chatRequestId: 'chat-zero-tenant',
    })).rejects.toMatchObject({
      name: 'TenantScopeError',
      code: 'TENANT_SCOPE_REQUIRED',
    });
    expect(mockPersistExchange).not.toHaveBeenCalled();
  });

  it('throws TenantScopeError when tenantId is negative', async () => {
    const err = new Error('overloaded');
    const res = mockRes();
    await expect(sendRetryableChatFailureResponseIfNeeded({
      err,
      res,
      userId: 42,
      tenantId: -1,
      normalizedText: 'olá',
      chatRequestId: 'chat-negative-tenant',
    })).rejects.toMatchObject({
      name: 'TenantScopeError',
    });
  });
});
