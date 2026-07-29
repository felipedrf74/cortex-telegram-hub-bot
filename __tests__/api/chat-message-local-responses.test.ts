// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCached = vi.fn();
const mockSetCache = vi.fn();
const mockTryDeterministicChatCommand = vi.fn();
const mockTrySecretaryFastpath = vi.fn();
const mockGetUserLanguageById = vi.fn();
const mockGetPreferredDisplayNameById = vi.fn();

vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
}));

vi.mock('../../src/api/routes/chat-fastpath', () => ({
  tryDeterministicChatCommand: (...args: unknown[]) => mockTryDeterministicChatCommand(...args),
  getPendingTasksCacheKey: (userId?: number, tenantId?: number) =>
    `u:${userId ?? 'unknown'}:t:${tenantId ?? userId ?? 'unknown'}:fastpath:pending-tasks`,
}));

vi.mock('../../src/services/secretary-fastpath', () => ({
  tryFastpath: (...args: unknown[]) => mockTrySecretaryFastpath(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguageById: (...args: unknown[]) => mockGetUserLanguageById(...args),
  getPreferredDisplayNameById: (...args: unknown[]) => mockGetPreferredDisplayNameById(...args),
}));

import {
  getCachedChatCommandResponse,
  isCacheableChatCommand,
  maybeCacheChatCommandResponse,
  tryBuildAuthenticatedIdentityResponse,
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
    mockTrySecretaryFastpath.mockReset();
    mockGetUserLanguageById.mockReset();
    mockGetPreferredDisplayNameById.mockReset();
    mockGetUserLanguageById.mockReturnValue('en-US');
    mockGetPreferredDisplayNameById.mockReturnValue('');
    mockTrySecretaryFastpath.mockResolvedValue({ matched: false });
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
    expect(getCachedChatCommandResponse(42, '/day', 1001, 'en-US')).toBe(cached);
    expect(mockGetCached).toHaveBeenCalledWith('chat-cmd:1001:42:en:/day');

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

    maybeCacheChatCommandResponse(42, '/todo', response, 1001, 'en-US');
    expect(mockSetCache).toHaveBeenCalledWith('chat-cmd:1001:42:en:/todo', response, 60);

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

    expect(mockSetCache).toHaveBeenNthCalledWith(1, 'chat-cmd:1001:42:en:/day', response, 60);
    expect(mockSetCache).toHaveBeenNthCalledWith(2, 'chat-cmd:1002:42:en:/day', response, 60);
  });

  it('keeps deterministic command cache entries isolated by resolved response locale', () => {
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

    maybeCacheChatCommandResponse(42, '/day', response, 1001, 'en-US');
    maybeCacheChatCommandResponse(42, '/day', response, 1001, 'pt-BR');

    expect(mockSetCache).toHaveBeenNthCalledWith(1, 'chat-cmd:1001:42:en:/day', response, 60);
    expect(mockSetCache).toHaveBeenNthCalledWith(2, 'chat-cmd:1001:42:pt-BR:/day', response, 60);

    mockGetCached.mockReturnValue(response);
    getCachedChatCommandResponse(42, '/day', 1001, 'en-US');
    getCachedChatCommandResponse(42, '/day', 1001, 'pt-BR');
    expect(mockGetCached).toHaveBeenNthCalledWith(1, 'chat-cmd:1001:42:en:/day');
    expect(mockGetCached).toHaveBeenNthCalledWith(2, 'chat-cmd:1001:42:pt-BR:/day');
  });

  it('maps deterministic fast-path results into the iOS chat response envelope', async () => {
    mockTryDeterministicChatCommand.mockResolvedValue({
      text: '<b>Tasks</b>',
      domain: 'secretary',
      buttons: [[{ text: 'Today', callbackData: 'cmd:/day' }]],
    });

    const result = await tryBuildFastPathChatResponse('/todo', '/todo', 42, 42);

    expect(mockTryDeterministicChatCommand).toHaveBeenCalledWith('/todo', 42, 42);
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

  it('maps natural-language Secretary fast paths before the AI quota/model route', async () => {
    mockTryDeterministicChatCommand.mockResolvedValue(null);
    mockGetUserLanguageById.mockReturnValue('pt-PT');
    mockTrySecretaryFastpath.mockResolvedValue({
      matched: true,
      patternId: 'create_calendar_event',
      response: {
        text: 'Pronto ✅ Agendei no Outlook:\n• 📅 16/05/2026, 09:00–13:00 — Volei Lucas',
        domain: 'secretary',
      },
    });

    const result = await tryBuildFastPathChatResponse(
      'Colocar no calendario evento no proximo sabado, 16/5, das 9h as 13h. Volei Lucas',
      'colocar no calendario evento no proximo sabado, 16/5, das 9h as 13h. volei lucas',
      42,
      42,
    );

    expect(mockTrySecretaryFastpath).toHaveBeenCalledWith(
      42,
      'Colocar no calendario evento no proximo sabado, 16/5, das 9h as 13h. Volei Lucas',
      'pt-PT',
      42,
    );
    expect(result).toMatchObject({
      conversationDomain: 'secretary',
      cacheable: false,
      response: {
        text: expect.stringContaining('Agendei no Outlook'),
        domain: 'secretary',
        routeMethod: 'fast-path',
        confidence: 1,
        buttons: null,
        metadata: { patternId: 'create_calendar_event' },
      },
    });
  });

  it('uses the resolved English response locale for Secretary fast paths over a stored Portuguese profile', async () => {
    mockTryDeterministicChatCommand.mockResolvedValue(null);
    mockGetUserLanguageById.mockReturnValue('pt-BR');
    mockTrySecretaryFastpath.mockImplementation(async (
      _userId: number,
      _text: string,
      locale: string,
    ) => ({
      matched: true,
      patternId: 'list_calendar_events',
      response: {
        text: locale.startsWith('pt') ? 'Aqui está a sua agenda.' : 'Here is your agenda.',
        domain: 'secretary',
      },
    }));

    const result = await tryBuildFastPathChatResponse(
      'Muestra mi agenda',
      'muestra mi agenda',
      42,
      42,
      'en-US',
    );

    expect(mockTrySecretaryFastpath).toHaveBeenCalledWith(
      42,
      'Muestra mi agenda',
      'en-US',
      42,
    );
    expect(result?.response.text).toBe('Here is your agenda.');
  });

  it('answers identity questions from the authenticated user profile, not a founder prompt default', () => {
    mockGetUserLanguageById.mockReturnValue('pt-PT');
    mockGetPreferredDisplayNameById.mockReturnValue('Jaqueline');

    const result = tryBuildAuthenticatedIdentityResponse('Quem sou eu?', 'quem sou eu?', 84);

    expect(mockGetPreferredDisplayNameById).toHaveBeenCalledWith(84);
    expect(result?.conversationDomain).toBe('secretary');
    expect(result?.cacheable).toBe(false);
    expect(result?.response).toMatchObject({
      domain: 'secretary',
      routeMethod: 'authenticated-identity',
      confidence: 1,
      metadata: {
        type: 'authenticated_identity',
        userId: 84,
        hasDisplayName: true,
      },
    });
    expect(result?.response.text).toContain('Jaqueline');
    expect(result?.response.text).not.toContain('Felipe');
  });

  it('handles English identity questions without falling through to the model', () => {
    mockGetUserLanguageById.mockReturnValue('en-US');
    mockGetPreferredDisplayNameById.mockReturnValue('Jacqueline');

    const result = tryBuildAuthenticatedIdentityResponse('Who am I signed in as?', 'who am i signed in as?', 85);

    expect(result?.response.routeMethod).toBe('authenticated-identity');
    expect(result?.response.text).toContain('Jacqueline');
    expect(result?.response.text).toContain('authenticated session');
  });

  it('uses the resolved English response locale for identity over a stored Portuguese profile', () => {
    mockGetUserLanguageById.mockReturnValue('pt-BR');
    mockGetPreferredDisplayNameById.mockReturnValue('Jacqueline');

    const result = tryBuildAuthenticatedIdentityResponse(
      '¿Quién soy?',
      '¿quién soy?',
      85,
      'en-US',
    );

    expect(result?.response.text).toContain('authenticated session');
    expect(result?.response.text).not.toContain('sessão autenticada');
  });

  it('builds localized token-zero training-plan shortcuts', () => {
    mockGetUserLanguageById.mockReturnValue('pt-PT');

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

    mockGetUserLanguageById.mockReturnValue('en-US');
    const english = tryBuildTrainingPlanShortcutResponse('Create training plan', 'create training plan', 42);
    expect(english?.response.text).toContain('personalized training plan');
    expect(tryBuildTrainingPlanShortcutResponse('How is my day?', 'how is my day?', 42)).toBeNull();
  });

  it('uses the resolved English response locale for the training shortcut over a stored Portuguese profile', () => {
    mockGetUserLanguageById.mockReturnValue('pt-BR');

    const result = tryBuildTrainingPlanShortcutResponse(
      'Create training plan',
      'create training plan',
      42,
      'en-US',
    );

    expect(result?.response.text).toContain('personalized training plan');
    expect(result?.response.text).not.toContain('plano de treino personalizado');
  });
});
