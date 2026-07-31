import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocket as WsClient } from 'ws';
import fs from 'fs';
import path from 'path';

import {
  attachWebSocket,
  buildWebSocketAiBudgetErrorFrame,
  DEFAULT_WEBSOCKET_AUTH_TIMEOUT_MS,
  DEFAULT_WEBSOCKET_MAX_CONNECTIONS,
  DEFAULT_WEBSOCKET_MAX_CONNECTIONS_PER_IP,
  DEFAULT_WEBSOCKET_MAX_FRAME_BYTES,
  consumeWebSocketMessageBudget,
  executeWebSocketDomainHandlerWithLocale,
  isAllowedWebSocketOrigin,
  resolveWebSocketResponseLocale,
  resetWebSocketConnectionCountersForTests,
  webSocketAuthTimeoutMs,
  webSocketConnectionLimits,
  webSocketFrameByteLength,
  webSocketMaxPayloadBytes,
} from '../../src/api/websocket';
import { detectResponseLanguage } from '../../src/services/chat-language-detector';
import { getCurrentChatRequestLocale } from '../../src/services/chat-request-locale-context';

async function listenOnLoopback(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

describe('WebSocket security boundary helpers', () => {
  afterEach(() => {
    resetWebSocketConnectionCountersForTests();
  });

  it('allows native clients and configured Nexus origins but rejects hostile browser origins', () => {
    const previousAllowedOrigins = process.env.IOS_WS_ALLOWED_ORIGINS;
    delete process.env.IOS_WS_ALLOWED_ORIGINS;

    try {
      expect(isAllowedWebSocketOrigin(undefined)).toBe(true);
      expect(isAllowedWebSocketOrigin('https://nexushub.me')).toBe(true);
      expect(isAllowedWebSocketOrigin('https://api.nexushub.me')).toBe(true);

      expect(isAllowedWebSocketOrigin('null')).toBe(false);
      expect(isAllowedWebSocketOrigin('https://nexushub.me.evil.test')).toBe(false);
      expect(isAllowedWebSocketOrigin('not a url')).toBe(false);
    } finally {
      if (previousAllowedOrigins === undefined) {
        delete process.env.IOS_WS_ALLOWED_ORIGINS;
      } else {
        process.env.IOS_WS_ALLOWED_ORIGINS = previousAllowedOrigins;
      }
    }
  });

  it('enforces a rolling per-connection message budget', () => {
    const state: { messageTimestamps?: number[] } = {};

    expect(consumeWebSocketMessageBudget(state, 1_000, 2)).toBe(true);
    expect(consumeWebSocketMessageBudget(state, 1_100, 2)).toBe(true);
    expect(consumeWebSocketMessageBudget(state, 1_200, 2)).toBe(false);

    expect(consumeWebSocketMessageBudget(state, 62_000, 2)).toBe(true);
  });

  it('keeps an explicit small WebSocket frame cap before auth parsing', () => {
    const previousMax = process.env.IOS_WS_MAX_FRAME_BYTES;
    delete process.env.IOS_WS_MAX_FRAME_BYTES;

    try {
      expect(webSocketMaxPayloadBytes()).toBe(DEFAULT_WEBSOCKET_MAX_FRAME_BYTES);
      expect(webSocketFrameByteLength(Buffer.from('{"type":"auth"}'))).toBe(15);
      process.env.IOS_WS_MAX_FRAME_BYTES = '999999';
      expect(webSocketMaxPayloadBytes()).toBe(64 * 1024);
    } finally {
      if (previousMax === undefined) {
        delete process.env.IOS_WS_MAX_FRAME_BYTES;
      } else {
        process.env.IOS_WS_MAX_FRAME_BYTES = previousMax;
      }
    }

    const source = fs.readFileSync(path.resolve(__dirname, '../../src/api/websocket.ts'), 'utf8');
    expect(source).toContain('new WebSocketServer({ noServer: true, maxPayload: webSocketMaxPayloadBytes() })');
    expect(source).toContain('if (frameBytes > webSocketMaxPayloadBytes())');
    expect(source).toContain("ws.close(1009, 'Message too large')");
    expect(source).toContain("ws.close(4001, 'Invalid auth frame')");
  });

  it('exposes bounded auth timeout and connection limits', () => {
    const previousAuthTimeout = process.env.IOS_WS_AUTH_TIMEOUT_MS;
    const previousMaxConnections = process.env.IOS_WS_MAX_CONNECTIONS;
    const previousMaxConnectionsPerIp = process.env.IOS_WS_MAX_CONNECTIONS_PER_IP;

    try {
      delete process.env.IOS_WS_AUTH_TIMEOUT_MS;
      delete process.env.IOS_WS_MAX_CONNECTIONS;
      delete process.env.IOS_WS_MAX_CONNECTIONS_PER_IP;
      expect(webSocketAuthTimeoutMs()).toBe(DEFAULT_WEBSOCKET_AUTH_TIMEOUT_MS);
      expect(webSocketConnectionLimits()).toEqual({
        maxConnections: DEFAULT_WEBSOCKET_MAX_CONNECTIONS,
        maxConnectionsPerIp: DEFAULT_WEBSOCKET_MAX_CONNECTIONS_PER_IP,
      });

      process.env.IOS_WS_AUTH_TIMEOUT_MS = '1';
      process.env.IOS_WS_MAX_CONNECTIONS = '0';
      process.env.IOS_WS_MAX_CONNECTIONS_PER_IP = '999999';
      expect(webSocketAuthTimeoutMs()).toBe(100);
      expect(webSocketConnectionLimits()).toEqual({
        maxConnections: DEFAULT_WEBSOCKET_MAX_CONNECTIONS,
        maxConnectionsPerIp: 1_000,
      });
    } finally {
      if (previousAuthTimeout === undefined) delete process.env.IOS_WS_AUTH_TIMEOUT_MS;
      else process.env.IOS_WS_AUTH_TIMEOUT_MS = previousAuthTimeout;
      if (previousMaxConnections === undefined) delete process.env.IOS_WS_MAX_CONNECTIONS;
      else process.env.IOS_WS_MAX_CONNECTIONS = previousMaxConnections;
      if (previousMaxConnectionsPerIp === undefined) delete process.env.IOS_WS_MAX_CONNECTIONS_PER_IP;
      else process.env.IOS_WS_MAX_CONNECTIONS_PER_IP = previousMaxConnectionsPerIp;
    }
  });

  it('closes unauthenticated sockets after the auth timeout', async () => {
    const previousAuthTimeout = process.env.IOS_WS_AUTH_TIMEOUT_MS;
    process.env.IOS_WS_AUTH_TIMEOUT_MS = '100';
    resetWebSocketConnectionCountersForTests();

    const server = http.createServer();
    attachWebSocket(server);
    let client: WsClient | undefined;

    try {
      const port = await listenOnLoopback(server);
      client = new WsClient(`ws://127.0.0.1:${port}/ws`);
      await withTimeout(new Promise<void>((resolve, reject) => {
        client!.once('open', resolve);
        client!.once('error', reject);
      }), 1_000, 'websocket open');

      const closeResult = await withTimeout(new Promise<{ code: number; reason: string }>((resolve) => {
        client!.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
      }), 2_000, 'websocket auth timeout close');

      expect(closeResult.code).toBe(4001);
      expect(closeResult.reason).toBe('Auth timeout');
    } finally {
      if (client && client.readyState !== WsClient.CLOSED) {
        client.terminate();
      }
      await closeServer(server);
      if (previousAuthTimeout === undefined) delete process.env.IOS_WS_AUTH_TIMEOUT_MS;
      else process.env.IOS_WS_AUTH_TIMEOUT_MS = previousAuthTimeout;
      resetWebSocketConnectionCountersForTests();
    }
  });

  it('rejects excess websocket upgrades beyond the configured per-IP cap', async () => {
    const previousMaxConnections = process.env.IOS_WS_MAX_CONNECTIONS;
    const previousMaxConnectionsPerIp = process.env.IOS_WS_MAX_CONNECTIONS_PER_IP;
    const previousAuthTimeout = process.env.IOS_WS_AUTH_TIMEOUT_MS;
    process.env.IOS_WS_MAX_CONNECTIONS = '1';
    process.env.IOS_WS_MAX_CONNECTIONS_PER_IP = '1';
    process.env.IOS_WS_AUTH_TIMEOUT_MS = '5000';
    resetWebSocketConnectionCountersForTests();

    const server = http.createServer();
    attachWebSocket(server);
    let first: WsClient | undefined;
    let second: WsClient | undefined;

    try {
      const port = await listenOnLoopback(server);
      first = new WsClient(`ws://127.0.0.1:${port}/ws`);
      await withTimeout(new Promise<void>((resolve, reject) => {
        first!.once('open', resolve);
        first!.once('error', reject);
      }), 1_000, 'first websocket open');

      second = new WsClient(`ws://127.0.0.1:${port}/ws`);
      const statusCode = await withTimeout(new Promise<number>((resolve, reject) => {
        second!.once('unexpected-response', (_request, response) => resolve(response.statusCode || 0));
        second!.once('open', () => reject(new Error('second websocket unexpectedly opened')));
        second!.once('error', reject);
      }), 1_000, 'second websocket rejection');

      expect(statusCode).toBe(429);
    } finally {
      if (second && second.readyState !== WsClient.CLOSED) {
        second.terminate();
      }
      if (first && first.readyState !== WsClient.CLOSED) {
        first.terminate();
      }
      await closeServer(server);
      if (previousMaxConnections === undefined) delete process.env.IOS_WS_MAX_CONNECTIONS;
      else process.env.IOS_WS_MAX_CONNECTIONS = previousMaxConnections;
      if (previousMaxConnectionsPerIp === undefined) delete process.env.IOS_WS_MAX_CONNECTIONS_PER_IP;
      else process.env.IOS_WS_MAX_CONNECTIONS_PER_IP = previousMaxConnectionsPerIp;
      if (previousAuthTimeout === undefined) delete process.env.IOS_WS_AUTH_TIMEOUT_MS;
      else process.env.IOS_WS_AUTH_TIMEOUT_MS = previousAuthTimeout;
      resetWebSocketConnectionCountersForTests();
    }
  });

  it('routes WebSocket chat messages through the action planner before generic routing', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/api/websocket.ts'), 'utf8');
    const plannerIndex = source.indexOf('tryHandleChatActionPlan({');
    const routerIndex = source.indexOf('const rawRoute = await routeMessage');

    expect(plannerIndex).toBeGreaterThan(-1);
    expect(routerIndex).toBeGreaterThan(-1);
    expect(plannerIndex).toBeLessThan(routerIndex);
    expect(source).toContain('inferChatTurnContract');
    expect(source).toContain('analyzeChatSkillOrchestration');
    expect(source).toContain('buildChatInternetResearchAnswer');
    expect(source).toContain('buildSimpleStateContext(researchDomain, userId, messageText, tenantId)');
    expect(source).toContain("preTurnContract?.riskClass === 'destructive'");
    expect(source).toContain('blockNonReadOnlyPlans: true');
    expect(source).toContain("type: 'status'");
    expect(source).toContain("status: 'ACTION_CONFIRMATION_REQUIRED'");
    expect(source).toContain("actionStatus: 'ACTION_CONFIRMATION_REQUIRED'");
  });

  it('terminates explicit manifest-classifier outcomes before skill orchestration and domain handlers', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/api/websocket.ts'), 'utf8');
    const routerIndex = source.indexOf('const rawRoute = await routeMessage');
    const terminalIndex = source.indexOf('const classifierTerminal = buildManifestClassifierTerminalResponse(');
    const orchestratorIndex = source.indexOf('const routingDecision = analyzeChatSkillOrchestration', routerIndex);
    const handlerIndex = source.indexOf('const handlers = getDomainHandlers()', routerIndex);

    expect(routerIndex).toBeGreaterThan(-1);
    expect(terminalIndex).toBeGreaterThan(routerIndex);
    expect(terminalIndex).toBeLessThan(orchestratorIndex);
    expect(terminalIndex).toBeLessThan(handlerIndex);
    expect(source).toContain("type: 'chat_manifest_classifier_terminal'");
  });

  it('binds Spanish-authored deterministic reads and action previews to English under a stored Portuguese locale', () => {
    expect(
      resolveWebSocketResponseLocale('pt-BR', '¿Qué tareas tengo para mañana?'),
    ).toBe('en-US');

    const source = fs.readFileSync(path.resolve(__dirname, '../../src/api/websocket.ts'), 'utf8');
    const localeResolutionIndex = source.indexOf('const responseLocale = resolveWebSocketResponseLocale(');
    const tokenZeroIndex = source.indexOf('if (await trySendTokenZeroSecretaryRead(ws, {');
    const firstPlannerIndex = source.indexOf('const deterministicAction = await tryHandleChatActionPlan({');
    const secondPlannerIndex = source.indexOf('const actionResult = await tryHandleChatActionPlan({');

    expect(localeResolutionIndex).toBeGreaterThan(-1);
    expect(tokenZeroIndex).toBeGreaterThan(localeResolutionIndex);
    expect(firstPlannerIndex).toBeGreaterThan(tokenZeroIndex);
    expect(secondPlannerIndex).toBeGreaterThan(firstPlannerIndex);
    expect(source.slice(tokenZeroIndex, firstPlannerIndex)).toContain('locale: responseLocale');
    expect(source.slice(firstPlannerIndex, secondPlannerIndex)).toContain('locale: responseLocale');
    expect(source.slice(secondPlannerIndex)).toContain('locale: responseLocale');
    expect(source).toContain('locale: input.locale');
  });

  it.each(['Hola', 'Buenos días', 'Gracias', 'Quiero ayuda'])(
    'selects the English compatibility response for short Spanish input: %s',
    (message) => {
      expect(resolveWebSocketResponseLocale('pt-BR', message)).toBe('en-US');
    },
  );

  it('emits the stable typed WebSocket frame for a budget denial', () => {
    const frame = buildWebSocketAiBudgetErrorFrame({
      name: 'AiBudgetError',
      decision: {
        allowed: false,
        status: 429,
        code: 'AI_MONTHLY_LIMIT_REACHED',
        window: 'monthly',
        message: 'monthly limit',
        quota: {
          plan: 'pro',
          usageFraction: 1,
          dailyUsageFraction: 0.4,
          monthlyUsageFraction: 1,
          dailyOver: false,
          monthlyOver: true,
        },
        reservedCostUsd: 0.01,
        retryAfterSeconds: 120,
        unblocksAt: '2026-08-01T00:00:00.000Z',
      },
    }, 42, 42);

    expect(frame).toMatchObject({
      type: 'error',
      code: 'AI_MONTHLY_LIMIT_REACHED',
      message: 'monthly limit',
      userId: 42,
      tenantId: 42,
      details: {
        window: 'monthly',
        unblocksAt: '2026-08-01T00:00:00.000Z',
        retryAfterSeconds: 120,
        retryable: true,
      },
    });
  });

  it('projects a legacy Spanish locale to English and contains a mismatched provider reply before streaming', async () => {
    const rawPortuguese = 'A tarefa está pronta e a sua reunião foi agendada para amanhã. Já adicionei o lembrete à sua lista.';
    let providerCalls = 0;

    const executed = await executeWebSocketDomainHandlerWithLocale({
      locale: 'es-419',
      message: '¿Qué tengo para mañana?',
      userId: 42,
      tenantId: 42,
      handler: async () => {
        providerCalls += 1;
        expect(getCurrentChatRequestLocale()).toBe('en-US');
        return { text: rawPortuguese, domain: 'secretary' };
      },
    });

    expect(providerCalls).toBe(1);
    expect(executed.response.text).not.toContain(rawPortuguese);
    expect(detectResponseLanguage(executed.response.text).language).toBe('en');
    expect(executed.languageGuard).toMatchObject({
      contained: true,
      expected: 'en',
      detected: 'pt',
    });

    const source = fs.readFileSync(path.resolve(__dirname, '../../src/api/websocket.ts'), 'utf8');
    const containmentIndex = source.indexOf('const executed = await executeWebSocketDomainHandlerWithLocale({');
    const firstGenericChunkIndex = source.indexOf(
      'await streamTextFrame(ws, { text: result.text, messageId, userId, tenantId });',
      containmentIndex,
    );
    expect(containmentIndex).toBeGreaterThan(-1);
    expect(firstGenericChunkIndex).toBeGreaterThan(containmentIndex);
    expect(source).not.toContain('await handler(route.strippedMessage, userId, tenantId)');
  });

  it('uses English for a clearly Spanish-authored message even when the stored locale is Portuguese', async () => {
    const rawEnglish = 'The task is ready and your meeting is scheduled for tomorrow. I have added the reminder to your list.';

    const executed = await executeWebSocketDomainHandlerWithLocale({
      locale: 'pt-BR',
      message: '¿Qué tareas tengo para mañana?',
      userId: 42,
      tenantId: 42,
      handler: async () => {
        expect(getCurrentChatRequestLocale()).toBe('en-US');
        return { text: rawEnglish, domain: 'secretary' };
      },
    });

    expect(executed.response.text).toBe(rawEnglish);
    expect(executed.languageGuard).toMatchObject({
      contained: false,
      expected: 'en',
      detected: 'en',
    });
  });

  it.each([
    'Gracias.',
    'Entendido.',
    'De acuerdo.',
    'Here you go. Gracias por esperar.',
  ])('contains short or mixed Spanish provider output before WebSocket streaming: %s', async (text) => {
    const executed = await executeWebSocketDomainHandlerWithLocale({
      locale: 'en-US',
      message: 'Show my priorities',
      userId: 42,
      tenantId: 42,
      handler: async () => ({ text, domain: 'secretary' }),
    });

    expect(executed.response.text).not.toBe(text);
    expect(executed.languageGuard).toMatchObject({
      contained: true,
      expected: 'en',
      detected: 'es',
    });
  });

  it('keeps supported Portuguese in request context and preserves matching provider text byte-for-byte', async () => {
    const rawPortuguese = 'A tarefa está pronta e a sua reunião foi agendada para amanhã. Já adicionei o lembrete à sua lista.';

    const executed = await executeWebSocketDomainHandlerWithLocale({
      locale: 'pt-BR',
      message: 'O que tenho para amanhã?',
      userId: 42,
      tenantId: 42,
      handler: async () => {
        expect(getCurrentChatRequestLocale()).toBe('pt-BR');
        return { text: rawPortuguese, domain: 'secretary' };
      },
    });

    expect(executed.response.text).toBe(rawPortuguese);
    expect(executed.languageGuard).toMatchObject({
      contained: false,
      expected: 'pt',
      detected: 'pt',
    });
  });

  it('keeps the stored Portuguese variant when the authored message is ambiguous', async () => {
    const rawPortuguese = 'A tarefa está pronta e a sua reunião foi agendada para amanhã. Já adicionei o lembrete à sua lista.';

    const executed = await executeWebSocketDomainHandlerWithLocale({
      locale: 'pt-PT',
      message: 'Status?',
      userId: 42,
      tenantId: 42,
      handler: async () => {
        expect(getCurrentChatRequestLocale()).toBe('pt-PT');
        return { text: rawPortuguese, domain: 'secretary' };
      },
    });

    expect(executed.response.text).toBe(rawPortuguese);
    expect(executed.languageGuard).toMatchObject({
      contained: false,
      expected: 'pt',
      detected: 'pt',
    });
  });

  it('locally replaces a confident English reply on a Portuguese request without retrying the provider', async () => {
    const rawEnglish = 'The task is ready and your meeting is scheduled for tomorrow. I have added the reminder to your list.';
    let providerCalls = 0;

    const executed = await executeWebSocketDomainHandlerWithLocale({
      locale: 'pt-PT',
      message: 'O que tenho para amanhã?',
      userId: 42,
      tenantId: 42,
      handler: async () => {
        providerCalls += 1;
        return { text: rawEnglish, domain: 'secretary' };
      },
    });

    expect(providerCalls).toBe(1);
    expect(executed.response.text).not.toContain(rawEnglish);
    expect(detectResponseLanguage(executed.response.text).language).toBe('pt');
    expect(executed.languageGuard).toMatchObject({
      contained: true,
      expected: 'pt',
      detected: 'en',
    });
  });

  it.each([
    {
      locale: 'es-419',
      rawReply: 'Aquí tienes.',
      expectedLanguage: 'en',
      detectedLanguage: 'es',
    },
    {
      locale: 'en-US',
      rawReply: 'Pronto.',
      expectedLanguage: 'en',
      detectedLanguage: 'pt',
    },
  ])(
    'contains an unambiguous short $detectedLanguage reply before WebSocket streaming',
    async ({ locale, rawReply, expectedLanguage, detectedLanguage }) => {
      let providerCalls = 0;
      const executed = await executeWebSocketDomainHandlerWithLocale({
        locale,
        message: 'Show my current priorities',
        userId: 42,
        tenantId: 42,
        handler: async () => {
          providerCalls += 1;
          return { text: rawReply, domain: 'secretary' };
        },
      });

      expect(providerCalls).toBe(1);
      expect(executed.response.text).not.toContain(rawReply);
      expect(executed.languageGuard).toMatchObject({
        contained: true,
        expected: expectedLanguage,
        detected: detectedLanguage,
      });
    },
  );
});
