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
  isAllowedWebSocketOrigin,
  resetWebSocketConnectionCountersForTests,
  webSocketAuthTimeoutMs,
  webSocketConnectionLimits,
  webSocketFrameByteLength,
  webSocketMaxPayloadBytes,
} from '../../src/api/websocket';

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
});
