// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCached = vi.fn();
const mockSetCache = vi.fn();
const mockTryDeterministicChatCommand = vi.fn();
const mockGetUserLanguage = vi.fn();

vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
}));

vi.mock('../../src/api/routes/chat-fastpath', () => ({
  tryDeterministicChatCommand: (...args: unknown[]) => mockTryDeterministicChatCommand(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: (...args: unknown[]) => mockGetUserLanguage(...args),
}));

import {
  getCachedChatCommandResponse,
  isCacheableChatCommand,
  maybeCacheChatCommandResponse,
  tryBuildFastPathChatResponse,
  tryBuildTrainingPlanShortcutResponse,
} from '../../src/api/routes/chat-message-local-responses';

describe('chat message local response helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T10:15:00.000Z'));

    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockTryDeterministicChatCommand.mockReset();
    mockGetUserLanguage.mockReset();
    mockGetUserLanguage.mockReturnValue('en-US');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('only reads cache for deterministic cacheable chat commands', () => {
    const cached = {
      id: 'msg-cached',
      text: 'Cached day',
      domain: 'secretary',
      routeMethod: 'fast-path',
      confidence: 1,
      buttons: null,
      metadata: null,
      timestamp: '2026-04-24T10:00:00.000Z',
    };
    mockGetCached.mockReturnValue(cached);

    expect(isCacheableChatCommand('/day')).toBe(true);
    expect(getCachedChatCommandResponse(42, '/day', 1001)).toBe(cached);
    expect(mockGetCached).toHaveBeenCalledWith('chat-cmd:1001:42:/day');

    mockGetCached.mockClear();
    expect(isCacheableChatCommand('tell me about my day')).toBe(false);
    expect(getCachedChatCommandResponse(42, 'tell me about my day', 1001)).toBeNull();
    expect(mockGetCached).not.toHaveBeenCalled();
  });

  it('caches deterministic local responses with the short chat command TTL', () => {
    const response = {
      id: 'msg-fast',
      text: 'Tasks',
      domain: 'secretary' as const,
      routeMethod: 'fast-path',
      confidence: 1,
      buttons: null,
      metadata: null,
      timestamp: '2026-04-24T10:15:00.000Z',
    };

    maybeCacheChatCommandResponse(42, '/todo', response, 1001);
    expect(mockSetCache).toHaveBeenCalledWith('chat-cmd:1001:42:/todo', response, 60);

    mockSetCache.mockClear();
    maybeCacheChatCommandResponse(42, 'create a task', response, 1001);
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it('keeps deterministic command cache entries isolated by tenant for the same user', () => {
    const response = {
      id: 'msg-fast',
      text: 'Tasks',
      domain: 'secretary' as const,
      routeMethod: 'fast-path',
      confidence: 1,
      buttons: null,
      metadata: null,
      timestamp: '2026-04-24T10:15:00.000Z',
    };

    maybeCacheChatCommandResponse(42, '/day', response, 1001);
    maybeCacheChatCommandResponse(42, '/day', response, 1002);

    expect(mockSetCache).toHaveBeenNthCalledWith(1, 'chat-cmd:1001:42:/day', response, 60);
    expect(mockSetCache).toHaveBeenNthCalledWith(2, 'chat-cmd:1002:42:/day', response, 60);
  });

  it('maps deterministic fast-path results into the iOS chat response envelope', async () => {
    mockTryDeterministicChatCommand.mockResolvedValue({
      text: '<b>Tasks</b>',
      domain: 'secretary',
      buttons: [[{ text: 'Today', callbackData: 'cmd:/day' }]],
    });

    const result = await tryBuildFastPathChatResponse('/todo', '/todo', 42);

    expect(mockTryDeterministicChatCommand).toHaveBeenCalledWith('/todo', 42);
    expect(result).toEqual({
      conversationDomain: 'secretary',
      cacheable: true,
      response: {
        id: expect.stringMatching(/^msg-/),
        text: '<b>Tasks</b>',
        domain: 'secretary',
        routeMethod: 'fast-path',
        confidence: 1,
        buttons: [[{ text: 'Today', callbackData: 'cmd:/day' }]],
        metadata: null,
        timestamp: '2026-04-24T10:15:00.000Z',
      },
    });
  });

  it('returns null when there is no deterministic fast-path response', async () => {
    mockTryDeterministicChatCommand.mockResolvedValue(null);

    await expect(tryBuildFastPathChatResponse('hello', 'hello', 42)).resolves.toBeNull();
  });

  it('builds localized token-zero training-plan shortcuts', () => {
    mockGetUserLanguage.mockReturnValue('pt-PT');

    const portuguese = tryBuildTrainingPlanShortcutResponse(
      'Quero criar plano de treino',
      'quero criar plano de treino',
      42,
    );

    expect(portuguese?.conversationDomain).toBe('triathlon');
    expect(portuguese?.cacheable).toBe(false);
    expect(portuguese?.response).toMatchObject({
      domain: 'triathlon',
      routeMethod: 'plan-shortcut',
      text: expect.stringContaining('plano de treino personalizado'),
    });

    mockGetUserLanguage.mockReturnValue('en-US');
    const english = tryBuildTrainingPlanShortcutResponse('Create training plan', 'create training plan', 42);
    expect(english?.response.text).toContain('personalized training plan');
    expect(tryBuildTrainingPlanShortcutResponse('How is my day?', 'how is my day?', 42)).toBeNull();
  });
});
