// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouteResult } from '../../src/router';

const hoisted = vi.hoisted(() => ({
  listLegacyToolLoopCheckpoints: vi.fn(() => [] as Array<{ toolName: string; sequence: number; completedAt: string }>),
}));

// M18: the timeout path lazily reads checkpointed tool progress from the
// run store. Mocked so this suite needs no database.
vi.mock('../../src/services/chat-action-run-store', async () => ({
  ...(await vi.importActual('../../src/services/chat-action-run-store')),
  listLegacyToolLoopCheckpoints: (...args: unknown[]) => hoisted.listLegacyToolLoopCheckpoints(...args as []),
}));

import {
  CHAT_DOMAIN_HANDLER_TIMEOUT_MS,
  ChatDomainTimeoutError,
  buildChatHandlerResponseEnvelope,
  buildChatTimeoutPartialReplyText,
  executeChatDomainHandler,
} from '../../src/api/routes/chat-message-execution';
import { getCurrentChatRequestLocale } from '../../src/services/chat-request-locale-context';

describe('chat message execution helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
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

  it('scopes the explicit app locale through the asynchronous domain handler', async () => {
    const handler = vi.fn(async () => ({
      text: `locale=${getCurrentChatRequestLocale()}`,
      domain: 'content' as const,
    }));

    await expect(executeChatDomainHandler(
      handler,
      'Dame ideas de contenido',
      42,
      1001,
      undefined,
      undefined,
      undefined,
      { locale: 'es-419' },
    )).resolves.toMatchObject({ text: 'locale=en-US' });
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

  // ─── M18: typed timeout + checkpointed partial progress ───────────
  it('rejects with ChatDomainTimeoutError carrying the run id and checkpointed tool summaries', async () => {
    vi.useFakeTimers();
    hoisted.listLegacyToolLoopCheckpoints.mockReturnValue([
      { toolName: 'ms_todo_get_tasks', sequence: 1, completedAt: '2026-07-21T10:00:00.000Z' },
      { toolName: 'get_calendar_events', sequence: 2, completedAt: '2026-07-21T10:00:01.000Z' },
    ]);
    const handler = vi.fn(() => new Promise<never>(() => {}));

    const execution = executeChatDomainHandler(handler, 'slow request', 42, 1001, undefined, 'req-m18');
    const expectation = execution.then(
      () => { throw new Error('expected timeout rejection'); },
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(CHAT_DOMAIN_HANDLER_TIMEOUT_MS);

    const err = await expectation as ChatDomainTimeoutError;
    expect(err).toBeInstanceOf(ChatDomainTimeoutError);
    // Message parity with the pre-M18 timeout error — zero-checkpoint turns
    // keep the exact degraded behavior downstream.
    expect(err.message).toBe('Response timeout — AI is taking too long');
    expect(err.runId).toBe('req-m18');
    expect(err.checkpoints.map((c) => c.toolName)).toEqual(['ms_todo_get_tasks', 'get_calendar_events']);
    // The typed timeout must NOT look retryable: the zero-checkpoint path
    // relies on the route's existing non-retryable handling staying put.
    expect((err as unknown as { retryable?: boolean }).retryable).toBeUndefined();
    expect(hoisted.listLegacyToolLoopCheckpoints).toHaveBeenCalledWith({ runId: 'req-m18', userId: 42, tenantId: 1001 });
  });

  it('durably queues before rejection and attaches a later foreground result for zero-extra-call delivery', async () => {
    vi.useFakeTimers();
    hoisted.listLegacyToolLoopCheckpoints.mockReturnValue([
      { toolName: 'get_calendar_events', sequence: 1, completedAt: '2026-07-22T10:00:00.000Z' },
    ]);
    let resolveHandler!: (value: { text: string; domain: 'secretary' }) => void;
    const handler = vi.fn(() => new Promise<{ text: string; domain: 'secretary' }>((resolve) => {
      resolveHandler = resolve;
    }));
    const enqueue = vi.fn(() => ({ jobId: 'job-m18', notificationPolicy: 'apns' as const }));
    const attachLateResult = vi.fn();
    const attachLateFailure = vi.fn();

    const execution = executeChatDomainHandler(
      handler,
      'slow request',
      42,
      1001,
      undefined,
      'req-m18',
      { enqueue, attachLateResult, attachLateFailure },
    );
    const expectation = execution.then(
      () => { throw new Error('expected timeout rejection'); },
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(CHAT_DOMAIN_HANDLER_TIMEOUT_MS);

    const err = await expectation as ChatDomainTimeoutError;
    expect(enqueue).toHaveBeenCalledWith([
      { toolName: 'get_calendar_events', sequence: 1, completedAt: '2026-07-22T10:00:00.000Z' },
    ]);
    expect(err.continuation).toEqual({ jobId: 'job-m18', notificationPolicy: 'apns' });

    resolveHandler({ text: 'late answer', domain: 'secretary' });
    await Promise.resolve();
    expect(attachLateResult).toHaveBeenCalledWith(
      { jobId: 'job-m18', notificationPolicy: 'apns' },
      { text: 'late answer', domain: 'secretary' },
    );
    expect(attachLateFailure).not.toHaveBeenCalled();
  });

  it('durably marks a detached foreground rejection so the worker fails honestly instead of re-running the provider', async () => {
    vi.useFakeTimers();
    hoisted.listLegacyToolLoopCheckpoints.mockReturnValue([
      { toolName: 'get_calendar_events', sequence: 1, completedAt: '2026-07-22T10:00:00.000Z' },
    ]);
    let rejectHandler!: (reason: Error) => void;
    const handler = vi.fn(() => new Promise<never>((_resolve, reject) => {
      rejectHandler = reject;
    }));
    const enqueue = vi.fn(() => ({ jobId: 'job-m18-failed', notificationPolicy: 'apns' as const }));
    const attachLateResult = vi.fn();
    const attachLateFailure = vi.fn();

    const execution = executeChatDomainHandler(
      handler,
      'slow request',
      42,
      1001,
      undefined,
      'req-m18-failed',
      { enqueue, attachLateResult, attachLateFailure },
    );
    const expectation = execution.then(
      () => { throw new Error('expected timeout rejection'); },
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(CHAT_DOMAIN_HANDLER_TIMEOUT_MS);
    await expectation;

    const providerError = new Error('provider definitively failed');
    rejectHandler(providerError);
    await Promise.resolve();
    expect(attachLateFailure).toHaveBeenCalledWith(
      { jobId: 'job-m18-failed', notificationPolicy: 'apns' },
      providerError,
    );
    expect(attachLateResult).not.toHaveBeenCalled();
  });

  it('carries zero checkpoints when the turn has no chatRequestId (degraded behavior unchanged)', async () => {
    vi.useFakeTimers();
    const handler = vi.fn(() => new Promise<never>(() => {}));

    const execution = executeChatDomainHandler(handler, 'slow request', 42);
    const expectation = execution.then(
      () => { throw new Error('expected timeout rejection'); },
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(CHAT_DOMAIN_HANDLER_TIMEOUT_MS);

    const err = await expectation as ChatDomainTimeoutError;
    expect(err).toBeInstanceOf(ChatDomainTimeoutError);
    expect(err.checkpoints).toEqual([]);
    expect(hoisted.listLegacyToolLoopCheckpoints).not.toHaveBeenCalled();
  });

  it('fails open to zero checkpoints when the run store read throws at timeout time', async () => {
    vi.useFakeTimers();
    hoisted.listLegacyToolLoopCheckpoints.mockImplementation(() => {
      throw new Error('db unavailable');
    });
    const handler = vi.fn(() => new Promise<never>(() => {}));

    const execution = executeChatDomainHandler(handler, 'slow request', 42, 1001, undefined, 'req-m18');
    const expectation = execution.then(
      () => { throw new Error('expected timeout rejection'); },
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(CHAT_DOMAIN_HANDLER_TIMEOUT_MS);

    const err = await expectation as ChatDomainTimeoutError;
    expect(err).toBeInstanceOf(ChatDomainTimeoutError);
    expect(err.message).toBe('Response timeout — AI is taking too long');
    expect(err.checkpoints).toEqual([]);
  });

  it('builds a deterministic, locale-aware partial-progress reply naming the completed tools', () => {
    const en = buildChatTimeoutPartialReplyText('en-US', ['ms_todo_get_tasks', 'get_calendar_events', 'ms_todo_get_tasks']);
    expect(en).toContain('ms todo get tasks');
    expect(en).toContain('get calendar events');
    // Deduplicated: the repeated tool appears once.
    expect(en.match(/ms todo get tasks/g)).toHaveLength(1);
    expect(en.toLowerCase()).toContain('continue');

    const pt = buildChatTimeoutPartialReplyText('pt-PT', ['search_notes']);
    expect(pt).toContain('search notes');
    expect(pt).toContain('continuar');

    const es = buildChatTimeoutPartialReplyText('es-419', ['search_notes']);
    expect(es).toContain('search notes');
    expect(es).toContain('continue');
    expect(es).not.toContain('continuar');

    const queued = buildChatTimeoutPartialReplyText('en-US', ['search_notes'], true);
    expect(queued).toContain('in-flight request');
    expect(queued).toContain('whether it completes or stops');
    expect(queued).toContain('will not start it again');
    expect(queued).toContain('require confirmation');
    expect(queued).not.toContain('notify you when it finishes');

    const queuedPt = buildChatTimeoutPartialReplyText('pt-BR', ['search_notes'], true);
    expect(queuedPt).toContain('pedido em curso');
    expect(queuedPt).toContain('se concluir ou parar');

    const queuedEs = buildChatTimeoutPartialReplyText('es-419', ['search_notes'], true);
    expect(queuedEs).toContain('in-flight request');
    expect(queuedEs).toContain('whether it completes or stops');
    expect(queuedEs).not.toContain('solicitud en curso');

    // Unknown locale falls back to English.
    expect(buildChatTimeoutPartialReplyText(null, ['search_notes'])).toContain('search notes');
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
