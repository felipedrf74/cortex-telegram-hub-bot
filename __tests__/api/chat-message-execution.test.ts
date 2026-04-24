// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouteResult } from '../../src/router';
import {
  CHAT_DOMAIN_HANDLER_TIMEOUT_MS,
  buildChatHandlerResponseEnvelope,
  executeChatDomainHandler,
} from '../../src/api/routes/chat-message-execution';

describe('chat message execution helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes the routed domain handler with the stripped message and user scope', async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({
      text: 'Agenda looks clear.',
      domain: 'secretary',
    });

    await expect(executeChatDomainHandler(handler, 'What is next?', 42)).resolves.toEqual({
      text: 'Agenda looks clear.',
      domain: 'secretary',
    });

    expect(handler).toHaveBeenCalledWith('What is next?', 42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails with the existing iOS-safe timeout before the client gives up', async () => {
    vi.useFakeTimers();
    const handler = vi.fn(() => new Promise<never>(() => {}));

    const execution = executeChatDomainHandler(handler, 'slow request', 42);
    const timeoutExpectation = expect(execution).rejects.toThrow('Response timeout — AI is taking too long');
    await vi.advanceTimersByTimeAsync(CHAT_DOMAIN_HANDLER_TIMEOUT_MS);

    await timeoutExpectation;
    expect(handler).toHaveBeenCalledWith('slow request', 42);
  });

  it('builds the stable chat response envelope from route and handler output', () => {
    const route: RouteResult = {
      domain: 'finance',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'budget today',
    };

    expect(buildChatHandlerResponseEnvelope({
      route,
      result: { text: 'Budget is stable.', domain: 'finance' },
      buttons: [[{ text: 'Open finance', callbackData: 'cmd:/finance' }]],
      timestamp: '2026-04-24T12:00:00.000Z',
      id: 'msg-test',
    })).toEqual({
      id: 'msg-test',
      text: 'Budget is stable.',
      domain: 'finance',
      routeMethod: 'keyword',
      confidence: 0.9,
      buttons: [[{ text: 'Open finance', callbackData: 'cmd:/finance' }]],
      metadata: null,
      timestamp: '2026-04-24T12:00:00.000Z',
    });
  });
});
