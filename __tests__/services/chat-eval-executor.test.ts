import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_EVAL_DEFAULT_MESSAGE_PATH,
  CHAT_EVAL_DEFAULT_SIDE_EFFECT_PATHS,
  FixtureExecutor,
  HttpExecutor,
  type ChatEvalHttpResponse,
  type ChatEvalTurnResult,
} from '../../src/services/chat-eval-executor';

function okEnvelope(overrides: Record<string, unknown> = {}): ChatEvalHttpResponse {
  return {
    statusCode: 200,
    body: {
      id: 'msg-1',
      text: 'Here is your agenda.',
      domain: 'secretary',
      routeMethod: 'context',
      confidence: 0.9,
      buttons: null,
      metadata: { skillsUsed: ['secretary'], providerTrace: { provider: 'gemini' } },
      timestamp: '2026-07-20T08:00:00.000Z',
      ...overrides,
    },
  };
}

describe('chat eval executor', () => {
  describe('FixtureExecutor', () => {
    it('echoes the pre-built fixture result bit-identically', async () => {
      const executor = new FixtureExecutor();
      const fixtureResult: ChatEvalTurnResult = {
        ok: true,
        statusCode: 200,
        text: 'fixture answer',
        domain: 'secretary',
        routeMethod: 'context',
        metadata: null,
        envelope: { id: 'sim-1' },
        latencyMs: 0,
        providerTrace: { mode: 'fixture' },
      };

      const result = await executor.executeTurn({
        text: 'What do I need to do today?',
        conversationId: 'conv-1',
        userId: 7001,
        tenantId: 501,
        fixtureResult,
      });

      expect(executor.mode).toBe('fixture');
      expect(result).toBe(fixtureResult);
    });

    it('returns a deterministic empty result when no fixture is attached', async () => {
      const executor = new FixtureExecutor();
      const result = await executor.executeTurn({
        text: 'hello',
        conversationId: 'conv-1',
        userId: 7001,
        tenantId: 501,
      });

      expect(result).toEqual({ ok: true, statusCode: 200, text: '', envelope: null, latencyMs: 0 });
    });
  });

  describe('HttpExecutor', () => {
    it('requires an injectable request function or a base URL', () => {
      expect(() => new HttpExecutor({ mode: 'local_engine', authToken: 'jwt' } as any)).toThrow(/request function or a baseUrl/);
    });

    it('POSTs the turn to the real chat message route with auth, tenant, and language headers', async () => {
      const request = vi.fn(async () => okEnvelope());
      const executor = new HttpExecutor({
        mode: 'real_provider',
        request,
        authToken: () => 'eval-jwt-token',
        locale: 'en',
      });

      const result = await executor.executeTurn({
        text: 'What do I need to do today?',
        conversationId: 'conv-a',
        userId: 7001,
        tenantId: 501,
      });

      expect(executor.mode).toBe('real_provider');
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith({
        method: 'POST',
        path: CHAT_EVAL_DEFAULT_MESSAGE_PATH,
        headers: {
          authorization: 'Bearer eval-jwt-token',
          'content-type': 'application/json',
          'x-nexus-active-tenant-id': '501',
          'x-language': 'en',
        },
        body: {
          text: 'What do I need to do today?',
          clientMessageId: 'conv-a-turn-1',
        },
      });
      expect(result.ok).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.text).toBe('Here is your agenda.');
      expect(result.domain).toBe('secretary');
      expect(result.routeMethod).toBe('context');
      expect(result.metadata).toMatchObject({ skillsUsed: ['secretary'] });
      expect(result.providerTrace).toEqual({ provider: 'gemini' });
      expect(result.envelope).toMatchObject({ id: 'msg-1' });
      expect(typeof result.latencyMs).toBe('number');
    });

    it('carries multi-turn conversation state via per-conversation client message ids', async () => {
      const request = vi.fn(async () => okEnvelope());
      const executor = new HttpExecutor({ mode: 'local_engine', request, authToken: 'jwt' });
      const base = { text: 'turn', userId: 7001, tenantId: 501 };

      await executor.executeTurn({ ...base, conversationId: 'conv-a' });
      await executor.executeTurn({ ...base, conversationId: 'conv-a' });
      await executor.executeTurn({ ...base, conversationId: 'conv-b' });
      await executor.executeTurn({ ...base, conversationId: 'conv-a', clientMessageId: 'explicit-id' });

      const clientIds = request.mock.calls.map((call) => (call[0].body as { clientMessageId: string }).clientMessageId);
      expect(clientIds).toEqual(['conv-a-turn-1', 'conv-a-turn-2', 'conv-b-turn-1', 'explicit-id']);
    });

    it('mixes a per-run nonce into fallback client message ids so reruns cannot collide with server idempotency', async () => {
      const buildExecutor = (runNonce: string) => {
        const request = vi.fn(async () => okEnvelope());
        return { request, executor: new HttpExecutor({ mode: 'local_engine', request, authToken: 'jwt', runNonce }) };
      };
      const base = { text: 'turn', userId: 7001, tenantId: 501, conversationId: 'conv-a' };

      const runA = buildExecutor('nonce-a');
      await runA.executor.executeTurn({ ...base });
      await runA.executor.executeTurn({ ...base });
      const runB = buildExecutor('nonce-b');
      await runB.executor.executeTurn({ ...base });

      const idsA = runA.request.mock.calls.map((call) => (call[0].body as { clientMessageId: string }).clientMessageId);
      const idsB = runB.request.mock.calls.map((call) => (call[0].body as { clientMessageId: string }).clientMessageId);
      // Same run stays deterministic per conversation...
      expect(idsA).toEqual(['conv-a-turn-1-nonce-a', 'conv-a-turn-2-nonce-a']);
      // ...while a different run nonce never repeats a prior run's ids.
      expect(idsB).toEqual(['conv-a-turn-1-nonce-b']);
      expect(idsA).not.toContain(idsB[0]);

      // Explicit clientMessageIds are still used verbatim.
      const explicit = buildExecutor('nonce-c');
      await explicit.executor.executeTurn({ ...base, clientMessageId: 'explicit-id' });
      expect((explicit.request.mock.calls[0][0].body as { clientMessageId: string }).clientMessageId).toBe('explicit-id');
    });

    it('maps non-200 responses to a scenario-blocked shape instead of throwing', async () => {
      const request = vi.fn(async () => ({
        statusCode: 429,
        body: { error: { code: 'AI_BUDGET_EXCEEDED', message: 'Daily AI budget exceeded' } },
      }));
      const executor = new HttpExecutor({ mode: 'real_provider', request, authToken: 'jwt' });

      const result = await executor.executeTurn({
        text: 'plan my day',
        conversationId: 'conv-a',
        userId: 7001,
        tenantId: 501,
      });

      expect(result.ok).toBe(false);
      expect(result.statusCode).toBe(429);
      expect(result.blockedReason).toBe('http_429:AI_BUDGET_EXCEEDED');
      expect(result.text).toBe('Daily AI budget exceeded');
      expect(result.envelope).toMatchObject({ error: { code: 'AI_BUDGET_EXCEEDED' } });
    });

    it('maps transport failures to a blocked result without leaking exceptions', async () => {
      const request = vi.fn(async () => {
        throw new Error('socket hang up');
      });
      const executor = new HttpExecutor({ mode: 'local_engine', request, authToken: 'jwt' });

      const result = await executor.executeTurn({
        text: 'plan my day',
        conversationId: 'conv-a',
        userId: 7001,
        tenantId: 501,
      });

      expect(result.ok).toBe(false);
      expect(result.statusCode).toBe(0);
      expect(result.blockedReason).toBe('transport_error: socket hang up');
      expect(result.envelope).toBeNull();
    });

    it('reads side effects through injected token-zero REST GETs with query params', async () => {
      const request = vi.fn(async () => ({ statusCode: 200, body: { ok: true, tasks: [{ id: 't-1' }] } }));
      const executor = new HttpExecutor({
        mode: 'real_provider',
        request,
        authToken: 'jwt',
        evalTenantId: 501,
      });

      const readBack = await executor.readSideEffect('tasks_list', { listId: 'inbox', limit: 5 });

      expect(request).toHaveBeenCalledWith({
        method: 'GET',
        path: `${CHAT_EVAL_DEFAULT_SIDE_EFFECT_PATHS.tasks_list}?listId=inbox&limit=5`,
        headers: {
          authorization: 'Bearer jwt',
          'x-nexus-active-tenant-id': '501',
        },
      });
      expect(readBack).toEqual({ statusCode: 200, body: { ok: true, tasks: [{ id: 't-1' }] } });
    });

    it('supports overriding the side-effect paths for calendar verification', async () => {
      const request = vi.fn(async () => ({ statusCode: 200, body: { ok: true, events: [] } }));
      const executor = new HttpExecutor({
        mode: 'local_engine',
        request,
        authToken: 'jwt',
        sideEffectPaths: { calendar_list: '/api/v1/calendar/today' },
      });

      await executor.readSideEffect('calendar_list', {});

      expect(request).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        path: '/api/v1/calendar/today',
      }));
    });
  });
});
