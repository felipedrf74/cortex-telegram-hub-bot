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

    await expect(executeChatDomainHandler(handler, 'What is next?', 42, 1001)).resolves.toEqual({
      text: 'Agenda looks clear.',
      domain: 'secretary',
    });

    expect(handler).toHaveBeenCalledWith('What is next?', 42, 1001);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails with the existing iOS-safe timeout before the client gives up', async () => {
    vi.useFakeTimers();
    const handler = vi.fn(() => new Promise<never>(() => {}));

    const execution = executeChatDomainHandler(handler, 'slow request', 42);
    const timeoutExpectation = expect(execution).rejects.toThrow('Response timeout — AI is taking too long');
    await vi.advanceTimersByTimeAsync(CHAT_DOMAIN_HANDLER_TIMEOUT_MS);

    await timeoutExpectation;
    expect(handler).toHaveBeenCalledWith('slow request', 42, undefined);
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

  it('generates collision-free default ids under 100 concurrent envelope builds (M11)', () => {
    // Freeze the clock: the old `msg-${Date.now()}` default collides for any
    // two envelopes built in the same millisecond.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T10:00:00Z'));
    const route: RouteResult = {
      domain: 'secretary',
      method: 'keyword',
      confidence: 0.8,
      strippedMessage: 'hello',
    };

    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const envelope = buildChatHandlerResponseEnvelope({
        route,
        result: { text: 'ok', domain: 'secretary' },
        buttons: null,
      });
      expect(envelope.id).toMatch(/^msg-/);
      ids.add(envelope.id);
    }
    expect(ids.size).toBe(100);
  });
});
