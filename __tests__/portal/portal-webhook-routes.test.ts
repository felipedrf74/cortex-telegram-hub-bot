import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSendPortalInternalError = vi.fn();

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => mockSendPortalInternalError(...args),
}));

import { registerPortalWebhookRoutes } from '../../src/portal/webhook-routes';

type Handler = (req: any, res: any, next?: () => void) => unknown;
type Method = 'GET' | 'POST' | 'DELETE';

interface CapturedRoute {
  method: Method;
  path: string;
  handlers: Handler[];
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createRegistry(overrides: Record<string, unknown> = {}) {
  return {
    verifySignature: vi.fn(() => true),
    receiveWebhookEvent: vi.fn(async () => 42),
    getSubscriptions: vi.fn(() => []),
    registerSubscription: vi.fn(() => 9),
    removeSubscription: vi.fn(() => true),
    getWebhookStats: vi.fn(() => ({ activeSubscriptions: 2 })),
    getRecentEvents: vi.fn(() => [{ id: 1, provider: 'github' }]),
    replayEvent: vi.fn(async () => true),
    ...overrides,
  };
}

function createConfig(overrides: Record<string, unknown> = {}) {
  return {
    whatsapp: {
      enabled: true,
      verifyToken: 'verify-token',
      appSecret: 'whatsapp-secret',
    },
    webhooks: {
      maxPayloadBytes: 1024,
      secret: 'fallback-secret',
    },
    ...overrides,
  };
}

function createRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    sent: undefined as unknown,
    typeValue: undefined as string | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    type(value: string) {
      this.typeValue = value;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    send(body: unknown) {
      this.sent = body;
      return this;
    },
  };
}

function captureRoutes(deps: Record<string, unknown> = {}): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const app = {
    get(path: string, ...handlers: Handler[]) {
      routes.push({ method: 'GET', path, handlers });
    },
    post(path: string, ...handlers: Handler[]) {
      routes.push({ method: 'POST', path, handlers });
    },
    delete(path: string, ...handlers: Handler[]) {
      routes.push({ method: 'DELETE', path, handlers });
    },
  };
  registerPortalWebhookRoutes(app as any, deps as any);
  return routes;
}

function findRoute(routes: CapturedRoute[], method: Method, path: string): CapturedRoute {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`Route not registered: ${method} ${path}`);
  return route;
}

async function invoke(route: CapturedRoute, req: Record<string, unknown> = {}) {
  const res = createRes();
  const handler = route.handlers.at(-1);
  if (!handler) throw new Error(`Route has no handler: ${route.method} ${route.path}`);
  await handler({ params: {}, query: {}, headers: {}, body: {}, ...req }, res);
  return res;
}

describe('portal webhook routes', () => {
  beforeEach(() => {
    mockSendPortalInternalError.mockReset();
  });

  it('registers WhatsApp and webhook infrastructure routes in safe order', () => {
    const routes = captureRoutes({ config: createConfig(), registry: createRegistry(), logger: createLogger() });

    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /api/webhooks/whatsapp',
      'POST /api/webhooks/whatsapp',
      'POST /api/webhooks/:provider',
      'GET /api/webhooks/stats',
      'GET /api/webhooks/subscriptions',
      'POST /api/webhooks/subscriptions',
      'DELETE /api/webhooks/subscriptions/:id',
      'GET /api/webhooks/events',
      'POST /api/webhooks/events/:id/replay',
    ]);
  });

  it('verifies WhatsApp challenge tokens and rejects bad verification', async () => {
    const logger = createLogger();
    const routes = captureRoutes({ config: createConfig(), registry: createRegistry(), logger });

    const ok = await invoke(findRoute(routes, 'GET', '/api/webhooks/whatsapp'), {
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-token',
        'hub.challenge': 'challenge-123',
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.sent).toBe('challenge-123');
    expect(logger.info).toHaveBeenCalledWith('WhatsApp webhook verified');

    const bad = await invoke(findRoute(routes, 'GET', '/api/webhooks/whatsapp'), {
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
      },
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.sent).toBe('Forbidden');
  });

  it('accepts signed WhatsApp payloads and records message telemetry', async () => {
    const logger = createLogger();
    const pushEvent = vi.fn();
    const body = Buffer.from(JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            contacts: [{ wa_id: '351000', profile: { name: 'Ana' } }],
            messages: [{ from: '351000', type: 'text', id: 'wamid.1', text: { body: 'Olá Nexus' } }],
          },
        }],
      }],
    }));
    const signature = 'sha256=' + crypto
      .createHmac('sha256', 'whatsapp-secret')
      .update(body)
      .digest('hex');
    const routes = captureRoutes({ config: createConfig(), registry: createRegistry(), logger, pushEvent });

    const res = await invoke(findRoute(routes, 'POST', '/api/webhooks/whatsapp'), {
      headers: { 'x-hub-signature-256': signature },
      body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.sent).toBe('OK');
    expect(pushEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      domain: 'whatsapp',
      summary: 'WhatsApp from Ana: Olá Nexus',
    }));
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ from: '351000', name: 'Ana', type: 'text', msgId: 'wamid.1' }),
      'WhatsApp incoming message',
    );
  });

  it('rejects WhatsApp POST webhooks when no app secret is configured', async () => {
    const routes = captureRoutes({
      config: createConfig({ whatsapp: { enabled: true, verifyToken: 'verify-token', appSecret: '' } }),
      registry: createRegistry(),
      logger: createLogger(),
    });

    const res = await invoke(findRoute(routes, 'POST', '/api/webhooks/whatsapp'), {
      body: Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] })),
    });

    expect(res.statusCode).toBe(403);
    expect(res.sent).toBe('Forbidden');
  });

  it('handles universal webhook verification shortcuts and event persistence', async () => {
    const registry = createRegistry({
      getSubscriptions: vi.fn(() => [{ id: 7, secret: 'subscription-secret' }]),
    });
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });

    const sync = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'google_gmail' },
      headers: { 'x-goog-resource-state': 'sync' },
    });
    expect(sync.statusCode).toBe(200);
    expect(sync.sent).toBe('OK');

    const validation = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'outlook_mail' },
      query: { validationToken: 'validate-me' },
    });
    expect(validation.statusCode).toBe(200);
    expect(validation.typeValue).toBe('text/plain');
    expect(validation.sent).toBe('validate-me');

    const body = Buffer.from(JSON.stringify({ changeType: 'created', subscriptionId: 'sub-1' }));
    const persisted = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'outlook_mail' },
      headers: { 'x-custom': 'one' },
      body,
    });

    expect(registry.verifySignature).toHaveBeenCalledWith(
      'outlook_mail',
      body,
      { 'x-custom': 'one' },
      'subscription-secret',
    );
    expect(registry.receiveWebhookEvent).toHaveBeenCalledWith({
      provider: 'outlook_mail',
      event_type: 'created',
      payload: { changeType: 'created', subscriptionId: 'sub-1' },
      headers: { 'x-custom': 'one' },
      idempotency_key: 'sub-1',
      subscription_id: 7,
    });
    expect(persisted.body).toEqual({ ok: true, eventId: 42 });
  });

  it('rejects universal webhooks when the active subscription has no secret', async () => {
    const registry = createRegistry({
      getSubscriptions: vi.fn(() => [{ id: 7, secret: '' }]),
    });
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });

    const res = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'outlook_mail' },
      body: Buffer.from(JSON.stringify({ changeType: 'created' })),
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ ok: false, message: 'Webhook signing secret is not configured' });
    expect(registry.verifySignature).not.toHaveBeenCalled();
    expect(registry.receiveWebhookEvent).not.toHaveBeenCalled();
  });

  it('supports subscription mutation routes and invalidates the snapshot cache', async () => {
    const clearPortalSnapshotCache = vi.fn();
    const registry = createRegistry();
    const routes = captureRoutes({
      config: createConfig(),
      registry,
      logger: createLogger(),
      clearPortalSnapshotCache,
    });

    const created = await invoke(findRoute(routes, 'POST', '/api/webhooks/subscriptions'), {
      body: { provider: 'github', event_types: ['push'], external_id: 'repo-1' },
    });
    expect(registry.registerSubscription).toHaveBeenCalledWith({
      provider: 'github',
      event_types: ['push'],
      endpoint_path: '/api/webhooks/github',
      secret: 'fallback-secret',
      external_id: 'repo-1',
      metadata: undefined,
      expires_at: undefined,
    });
    expect(created.body).toEqual({ ok: true, id: 9, endpoint: '/api/webhooks/github' });
    expect(clearPortalSnapshotCache).toHaveBeenCalledTimes(1);

    const removed = await invoke(findRoute(routes, 'DELETE', '/api/webhooks/subscriptions/:id'), {
      params: { id: '9' },
    });
    expect(registry.removeSubscription).toHaveBeenCalledWith(9);
    expect(removed.body).toEqual({ ok: true, message: 'Subscription removed' });
    expect(clearPortalSnapshotCache).toHaveBeenCalledTimes(2);
  });

  it('returns stats, filtered subscriptions, recent events, and replay results', async () => {
    const registry = createRegistry({
      getSubscriptions: vi.fn(() => [{ id: 1 }]),
      getRecentEvents: vi.fn(() => [{ id: 2, status: 'failed' }]),
      replayEvent: vi.fn(async () => false),
    });
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });

    expect((await invoke(findRoute(routes, 'GET', '/api/webhooks/stats'))).body).toEqual({
      ok: true,
      activeSubscriptions: 2,
    });
    expect((await invoke(findRoute(routes, 'GET', '/api/webhooks/subscriptions'), {
      query: { provider: 'github' },
    })).body).toEqual({ ok: true, subscriptions: [{ id: 1 }] });
    expect(registry.getSubscriptions).toHaveBeenCalledWith({ provider: 'github' });

    expect((await invoke(findRoute(routes, 'GET', '/api/webhooks/events'), {
      query: { provider: 'github', status: 'failed', limit: '300' },
    })).body).toEqual({ ok: true, events: [{ id: 2, status: 'failed' }] });
    expect(registry.getRecentEvents).toHaveBeenCalledWith({ provider: 'github', status: 'failed', limit: 200 });

    expect((await invoke(findRoute(routes, 'POST', '/api/webhooks/events/:id/replay'), {
      params: { id: '2' },
    })).body).toEqual({ ok: false, message: 'Replay failed' });
    expect(registry.replayEvent).toHaveBeenCalledWith(2);
  });

  it('uses shared safe portal errors for stats failures', async () => {
    const registry = createRegistry({
      getWebhookStats: vi.fn(() => {
        throw new Error('raw webhook database failure');
      }),
    });
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });
    const res = await invoke(findRoute(routes, 'GET', '/api/webhooks/stats'));

    expect(mockSendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Portal request failed',
      'Portal: request failed',
    );
  });
});
