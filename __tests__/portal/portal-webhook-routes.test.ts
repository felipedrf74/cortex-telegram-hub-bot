import crypto from 'crypto';
import express from 'express';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSendPortalInternalError = vi.fn();

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => mockSendPortalInternalError(...args),
}));

import {
  registerPortalWebhookManagementRoutes,
  registerPortalWebhookRoutes,
  registerPublicPortalWebhookRoutes,
} from '../../src/portal/webhook-routes';
import { extractIdempotencyKey } from '../../src/portal/webhooks';

type Handler = (req: any, res: any, next?: (value?: unknown) => void) => unknown;
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
    getSubscription: vi.fn((id: number) => ({ id, user_id: 42, secret: 'configured' })),
    registerSubscription: vi.fn(() => 9),
    removeSubscription: vi.fn(() => true),
    getWebhookStats: vi.fn(() => ({ activeSubscriptions: 2 })),
    getRecentEvents: vi.fn(() => [{ id: 1, provider: 'github' }]),
    getEvent: vi.fn((id: number) => ({ id, user_id: 42, status: 'failed' })),
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
      enabled: true,
      maxPayloadBytes: 1024,
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
  registerPortalWebhookRoutes(app as any, {
    authorizeTargetUser: () => true,
    operatorScopesConfigured: () => false,
    ...deps,
  } as any);
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

  it('mounts public raw callbacks before parsing/auth and management after portal auth', () => {
    const source = readFileSync(path.resolve(__dirname, '../../src/portal/server.ts'), 'utf8');
    const registryDatabaseProvider = source.indexOf('setWebhookDbProvider(() => getDb() as any);');
    const publicMount = source.indexOf('registerPublicPortalWebhookRoutes(app);');
    const jsonParser = source.indexOf('app.use(express.json());');
    const portalAuth = source.indexOf('return requirePortalTokenByMethod(req, res, next);');
    const managementMount = source.indexOf('registerPortalWebhookManagementRoutes(app);');

    expect(registryDatabaseProvider).toBeGreaterThan(-1);
    expect(registryDatabaseProvider).toBeLessThan(publicMount);
    expect(publicMount).toBeGreaterThan(-1);
    expect(publicMount).toBeLessThan(jsonParser);
    expect(jsonParser).toBeLessThan(portalAuth);
    expect(portalAuth).toBeLessThan(managementMount);
  });

  it('skips the public dynamic route before its raw parser for the management path', () => {
    const routes = captureRoutes({ config: createConfig(), registry: createRegistry(), logger: createLogger() });
    const route = findRoute(routes, 'POST', '/api/webhooks/:provider');
    const next = vi.fn();
    const res = createRes();

    route.handlers[0]({ params: { provider: 'subscriptions' } }, res, next);

    expect(next).toHaveBeenCalledWith('route');
    expect(res.body).toBeUndefined();
  });

  it('places the callback limiter before unsupported-provider rejection and raw parsing', () => {
    const source = readFileSync(path.resolve(__dirname, '../../src/portal/webhook-routes.ts'), 'utf8');
    const publicRoute = source.lastIndexOf("app.post('/api/webhooks/:provider'");
    const fallthroughGuard = source.indexOf('publicWebhookManagementFallthroughGuard,', publicRoute);
    const limiter = source.indexOf('rateLimitMiddleware,', fallthroughGuard);
    const providerGuard = source.indexOf('publicWebhookProviderValidationGuard,', limiter);
    const rawParser = source.indexOf('express.raw({', providerGuard);

    expect(publicRoute).toBeGreaterThan(-1);
    expect(publicRoute).toBeLessThan(fallthroughGuard);
    expect(fallthroughGuard).toBeLessThan(limiter);
    expect(limiter).toBeLessThan(providerGuard);
    expect(providerGuard).toBeLessThan(rawParser);
  });

  it('keeps management registered while the generic-ingress kill switch returns 503', async () => {
    const routes = captureRoutes({
      config: createConfig({ webhooks: { enabled: false, maxPayloadBytes: 1024 } }),
      registry: createRegistry(),
      logger: createLogger(),
    });
    const publicRoute = findRoute(routes, 'POST', '/api/webhooks/:provider');

    const disabled = await invoke(publicRoute, {
      params: { provider: 'custom' },
      body: Buffer.from('{}'),
    });

    expect(disabled.statusCode).toBe(503);
    expect(disabled.body).toEqual({ ok: false, message: 'Webhook ingestion is disabled' });
    expect(findRoute(routes, 'GET', '/api/webhooks/stats')).toBeTruthy();
  });

  it('composes raw public callbacks before auth while management falls through to JSON and auth', async () => {
    const app = express();
    const seenRawBodies: Buffer[] = [];
    const registry = createRegistry({
      getSubscriptions: vi.fn(() => [{
        id: 7,
        user_id: 42,
        secret: 'subscription-secret',
        external_id: 'custom-hook',
      }]),
      verifySignature: vi.fn((_provider: string, body: Buffer) => {
        seenRawBodies.push(body);
        return true;
      }),
    });
    const deps = {
      config: createConfig(),
      registry,
      logger: createLogger(),
      authorizeTargetUser: () => true,
      operatorScopesConfigured: () => false,
    };
    registerPublicPortalWebhookRoutes(app, deps as any);
    app.use(express.json());
    app.use('/api', (req, res, next) => {
      if (req.headers.authorization !== 'Bearer admin-test-token') {
        res.status(401).json({ ok: false });
        return;
      }
      next();
    });
    registerPortalWebhookManagementRoutes(app, deps as any);
    const server = app.listen(0, '127.0.0.1');

    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;
      const rawJson = '{ "id": "delivery-raw" }';

      const publicResponse = await fetch(`${baseUrl}/api/webhooks/custom`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': 'test' },
        body: rawJson,
      });
      expect(publicResponse.status).toBe(200);
      expect(seenRawBodies).toEqual([Buffer.from(rawJson)]);

      const noContentTypeBytes = Buffer.from('raw-without-content-type');
      const noContentTypeResponse = await fetch(`${baseUrl}/api/webhooks/custom`, {
        method: 'POST',
        headers: { 'x-webhook-signature': 'test' },
        body: noContentTypeBytes,
      });
      expect(noContentTypeResponse.status).toBe(200);
      expect(seenRawBodies).toEqual([Buffer.from(rawJson), noContentTypeBytes]);

      const emptyBodyResponse = await fetch(`${baseUrl}/api/webhooks/custom`, {
        method: 'POST',
        headers: { 'x-webhook-signature': 'test' },
      });
      expect(emptyBodyResponse.status).toBe(200);
      expect(seenRawBodies).toEqual([Buffer.from(rawJson), noContentTypeBytes, Buffer.alloc(0)]);

      const unauthenticatedManagement = await fetch(`${baseUrl}/api/webhooks/subscriptions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner_user_id: 42, provider: 'github', secret: 'unique-secret' }),
      });
      expect(unauthenticatedManagement.status).toBe(401);

      const authenticatedManagement = await fetch(`${baseUrl}/api/webhooks/subscriptions`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ owner_user_id: 42, provider: 'github', secret: 'unique-secret' }),
      });
      expect(authenticatedManagement.status).toBe(200);
      expect(registry.registerSubscription).toHaveBeenCalledWith(expect.objectContaining({
        user_id: 42,
        provider: 'github',
        secret: 'unique-secret',
      }));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
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
      summary: 'WhatsApp message received',
    }));
    expect(logger.info).toHaveBeenCalledWith(
      { type: 'text' },
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
      getSubscriptions: vi.fn(({ provider }: { provider?: string } = {}) => provider === 'google_calendar'
        ? [{ id: 6, user_id: 42, secret: 'google-token', external_id: 'channel-6' }]
        : [{ id: 7, user_id: 42, secret: 'subscription-secret', external_id: 'sub-1' }]),
    });
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });

    const sync = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'google_calendar' },
      headers: {
        'x-goog-resource-state': 'sync',
        'x-goog-channel-id': 'channel-6',
        'x-goog-channel-token': 'google-token',
      },
      body: Buffer.from('{}'),
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

    const notification = {
      changeType: 'created',
      subscriptionId: 'sub-1',
      clientState: 'subscription-secret',
    };
    const body = Buffer.from(JSON.stringify({ value: [notification] }));
    const persisted = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'outlook_mail' },
      headers: { 'x-custom': 'one' },
      body,
    });

    expect(registry.verifySignature).toHaveBeenCalledWith(
      'outlook_mail',
      Buffer.from(JSON.stringify(notification)),
      { 'x-custom': 'one' },
      'subscription-secret',
    );
    expect(registry.receiveWebhookEvent).toHaveBeenCalledWith({
      user_id: 42,
      provider: 'outlook_mail',
      event_type: 'created',
      payload: {
        changeType: 'created',
        subscriptionId: 'sub-1',
      },
      headers: {},
      idempotency_key: expect.stringMatching(/^outlook:[a-f0-9]{64}$/),
      subscription_id: 7,
    });
    expect(persisted.body).toEqual({ ok: true, eventId: 42 });
  });

  it('fails closed for Gmail until Pub/Sub OIDC identity verification is configured', async () => {
    const registry = createRegistry({
      getSubscriptions: vi.fn(() => [{ id: 6, user_id: 42, secret: 'wrong-contract' }]),
    });
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });

    const res = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'google_gmail' },
      body: Buffer.from(JSON.stringify({ message: { messageId: 'pubsub-1' } })),
    });

    expect(res.statusCode).toBe(501);
    expect(registry.getSubscriptions).not.toHaveBeenCalled();
    expect(registry.receiveWebhookEvent).not.toHaveBeenCalled();
  });

  it('fails closed for Strava until its native challenge and owner binding are configured', async () => {
    const registry = createRegistry({
      getSubscriptions: vi.fn(() => [{ id: 6, user_id: 42, secret: 'placeholder-hmac' }]),
    });
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });

    const res = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'strava' },
      body: Buffer.from(JSON.stringify({ object_id: 123, owner_id: 42 })),
    });

    expect(res.statusCode).toBe(501);
    expect(registry.getSubscriptions).not.toHaveBeenCalled();
    expect(registry.receiveWebhookEvent).not.toHaveBeenCalled();
  });

  it('binds every Outlook batch notification to exactly one subscription owner', async () => {
    const registry = createRegistry({
      getSubscriptions: vi.fn(() => [
        { id: 7, user_id: 42, secret: 'secret-a', external_id: 'sub-a' },
        { id: 8, user_id: 77, secret: 'secret-b', external_id: 'sub-b' },
      ]),
      verifySignature: vi.fn((
        _provider: string,
        body: Buffer,
        _headers: Record<string, string>,
        secret: string,
      ) => JSON.parse(body.toString('utf8')).clientState === secret),
      receiveWebhookEvent: vi.fn(async ({ subscription_id }: { subscription_id: number }) => subscription_id + 100),
    });
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });
    const res = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'outlook_calendar' },
      body: Buffer.from(JSON.stringify({ value: [
        { subscriptionId: 'sub-a', clientState: 'secret-a', changeType: 'updated', resource: '/events/a' },
        { subscriptionId: 'sub-b', clientState: 'secret-b', changeType: 'updated', resource: '/events/b' },
      ] })),
    });

    expect(res.body).toEqual({ ok: true, eventId: 107, eventIds: [107, 108] });
    expect(registry.receiveWebhookEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      user_id: 42,
      subscription_id: 7,
      payload: expect.not.objectContaining({ clientState: expect.anything() }),
    }));
    expect(registry.receiveWebhookEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      user_id: 77,
      subscription_id: 8,
      payload: expect.not.objectContaining({ clientState: expect.anything() }),
    }));
  });

  it('admits valid Outlook batch items without letting invalid siblings starve them', async () => {
    const registry = createRegistry({
      getSubscriptions: vi.fn(() => [{
        id: 7, user_id: 42, secret: 'secret-a', external_id: 'sub-a',
      }]),
      verifySignature: vi.fn((
        _provider: string,
        body: Buffer,
        _headers: Record<string, string>,
        secret: string,
      ) => JSON.parse(body.toString('utf8')).clientState === secret),
    });
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });
    const res = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'outlook_mail' },
      body: Buffer.from(JSON.stringify({ value: [
        { subscriptionId: 'sub-a', clientState: 'secret-a', resource: '/messages/valid' },
        { subscriptionId: 'sub-a', clientState: 'wrong', resource: '/messages/rejected' },
        'malformed',
      ] })),
    });

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({
      ok: true,
      eventId: 42,
      partial: true,
      rejected: { unauthorized: 1, ambiguous: 0, malformed: 1 },
    });
    expect(registry.receiveWebhookEvent).toHaveBeenCalledTimes(1);
    expect(registry.receiveWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ resource: '/messages/valid' }),
    }));
  });

  it('rejects Outlook notification batches beyond the pre-matching hard cap', async () => {
    const registry = createRegistry();
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });
    const route = findRoute(routes, 'POST', '/api/webhooks/:provider');

    const atCap = await invoke(route, {
      params: { provider: 'outlook_mail' },
      body: Buffer.from(JSON.stringify({ value: Array.from({ length: 1000 }, () => 'malformed') })),
    });
    expect(atCap.statusCode).toBe(400);
    expect(registry.getSubscriptions).toHaveBeenCalledTimes(1);

    (registry.getSubscriptions as ReturnType<typeof vi.fn>).mockClear();
    const overCap = await invoke(route, {
      params: { provider: 'outlook_mail' },
      body: Buffer.from(JSON.stringify({ value: Array.from({ length: 1001 }, () => 'malformed') })),
    });
    expect(overCap.statusCode).toBe(413);
    expect(registry.getSubscriptions).not.toHaveBeenCalled();
    expect(registry.verifySignature).not.toHaveBeenCalled();
    expect(registry.receiveWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects authenticated events outside the subscription event-type allowlist', async () => {
    const registry = createRegistry({
      getSubscriptions: vi.fn(() => [{
        id: 7,
        user_id: 42,
        secret: 'subscription-secret',
        event_types: ['push'],
      }]),
    });
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });
    const res = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'github' },
      headers: { 'x-github-event': 'issues', 'x-hub-signature-256': 'signature' },
      body: Buffer.from(JSON.stringify({ action: 'opened' })),
    });

    expect(res.statusCode).toBe(401);
    expect(registry.verifySignature).not.toHaveBeenCalled();
    expect(registry.receiveWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects universal webhooks when the active subscription has no secret', async () => {
    const registry = createRegistry({
      getSubscriptions: vi.fn(() => [{ id: 7, user_id: 42, secret: '', external_id: 'sub-1' }]),
    });
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });

    const res = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'outlook_mail' },
      body: Buffer.from(JSON.stringify({
        value: [{ changeType: 'created', subscriptionId: 'sub-1', clientState: 'secret' }],
      })),
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ ok: false, message: 'Invalid signature or subscription owner' });
    expect(registry.verifySignature).not.toHaveBeenCalled();
    expect(registry.receiveWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects unsupported providers before verification shortcuts or persistence', async () => {
    const registry = createRegistry();
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });
    const res = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'untrusted_provider' },
      query: { validationToken: 'should-not-echo' },
    });

    expect(res.statusCode).toBe(404);
    expect(registry.getSubscriptions).not.toHaveBeenCalled();
    expect(registry.receiveWebhookEvent).not.toHaveBeenCalled();
  });

  it('returns a retryable failure when event admission fails closed', async () => {
    const registry = createRegistry({
      getSubscriptions: vi.fn(() => [{ id: 7, user_id: 42, secret: 'subscription-secret' }]),
      receiveWebhookEvent: vi.fn(async () => -1),
    });
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });
    const res = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'github' },
      body: Buffer.from(JSON.stringify({ id: 'delivery-1' })),
    });

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ ok: false, message: 'Webhook event could not be admitted' });
  });

  it('derives distinct stable Outlook keys for independent notifications on one subscription', () => {
    const first = extractIdempotencyKey('outlook_mail', {}, {
      subscriptionId: 'shared-subscription', changeType: 'created', resource: '/messages/one',
    });
    const reorderedRetry = extractIdempotencyKey('outlook_mail', {}, {
      resource: '/messages/one', changeType: 'created', subscriptionId: 'shared-subscription',
    });
    const second = extractIdempotencyKey('outlook_mail', {}, {
      subscriptionId: 'shared-subscription', changeType: 'created', resource: '/messages/two',
    });

    expect(reorderedRetry).toBe(first);
    expect(second).not.toBe(first);
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
      body: {
        provider: 'github',
        owner_user_id: 42,
        event_types: ['push'],
        external_id: 'repo-1',
        secret: 'owner-specific-secret',
      },
    });
    expect(registry.registerSubscription).toHaveBeenCalledWith({
      user_id: 42,
      provider: 'github',
      event_types: ['push'],
      endpoint_path: '/api/webhooks/github',
      secret: 'owner-specific-secret',
      external_id: 'repo-1',
      metadata: undefined,
      expires_at: undefined,
    });
    expect(created.body).toEqual({ ok: true, id: 9, endpoint: '/api/webhooks/github' });
    expect(clearPortalSnapshotCache).toHaveBeenCalledTimes(1);

    const removed = await invoke(findRoute(routes, 'DELETE', '/api/webhooks/subscriptions/:id'), {
      params: { id: '9' },
    });
    expect(registry.removeSubscription).toHaveBeenCalledWith(9, 42);
    expect(removed.body).toEqual({ ok: true, message: 'Subscription removed' });
    expect(clearPortalSnapshotCache).toHaveBeenCalledTimes(2);
  });

  it('refuses webhook subscription creation without an explicit positive owner', async () => {
    const registry = createRegistry();
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });

    const created = await invoke(findRoute(routes, 'POST', '/api/webhooks/subscriptions'), {
      body: { provider: 'github', owner_user_id: 0 },
    });

    expect(created.statusCode).toBe(400);
    expect(registry.registerSubscription).not.toHaveBeenCalled();

    for (const malformedOwner of [true, [1]]) {
      const malformed = await invoke(findRoute(routes, 'POST', '/api/webhooks/subscriptions'), {
        body: {
          provider: 'github',
          owner_user_id: malformedOwner,
          secret: 'unique-secret',
        },
      });
      expect(malformed.statusCode).toBe(400);
    }
    expect(registry.registerSubscription).not.toHaveBeenCalled();
  });

  it('refuses shared fallback secrets and non-record subscription metadata', async () => {
    const registry = createRegistry();
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });
    const route = findRoute(routes, 'POST', '/api/webhooks/subscriptions');

    const missingSecret = await invoke(route, {
      body: { provider: 'github', owner_user_id: 42 },
    });
    expect(missingSecret.statusCode).toBe(400);

    const missingExternalIdentity = await invoke(route, {
      body: {
        provider: 'outlook_calendar',
        owner_user_id: 42,
        secret: 'unique-outlook-secret',
      },
    });
    expect(missingExternalIdentity.statusCode).toBe(400);

    const arrayMetadata = await invoke(route, {
      body: { provider: 'github', owner_user_id: 42, secret: 'unique', metadata: [] },
    });
    expect(arrayMetadata.statusCode).toBe(400);
    expect(registry.registerSubscription).not.toHaveBeenCalled();
  });

  it('rejects malformed, duplicate, and mixed-wildcard event-type allowlists', async () => {
    const registry = createRegistry();
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });
    const route = findRoute(routes, 'POST', '/api/webhooks/subscriptions');

    for (const eventTypes of [[], ['push', 'push'], ['*', 'push'], [' push']]) {
      const rejected = await invoke(route, {
        body: {
          provider: 'github',
          owner_user_id: 42,
          secret: 'unique-secret',
          event_types: eventTypes,
        },
      });
      expect(rejected.statusCode).toBe(400);
    }
    expect(registry.registerSubscription).not.toHaveBeenCalled();
  });

  it('rejects valid non-record JSON before persistence', async () => {
    const registry = createRegistry({
      getSubscriptions: vi.fn(() => [{ id: 7, user_id: 42, secret: 'subscription-secret' }]),
    });
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });
    const res = await invoke(findRoute(routes, 'POST', '/api/webhooks/:provider'), {
      params: { provider: 'custom' },
      body: Buffer.from('[{"event":"one"}]'),
    });

    expect(res.statusCode).toBe(400);
    expect(registry.receiveWebhookEvent).not.toHaveBeenCalled();
  });

  it('returns stats, filtered subscriptions, recent events, and replay results', async () => {
    const registry = createRegistry({
      getSubscriptions: vi.fn(() => [{ id: 1, secret: 'must-stay-private' }]),
      getRecentEvents: vi.fn(() => [{
        id: 2,
        status: 'failed',
        headers: { authorization: 'must-not-leave-the-server' },
      }]),
      replayEvent: vi.fn(async () => false),
    });
    const routes = captureRoutes({ config: createConfig(), registry, logger: createLogger() });

    expect((await invoke(findRoute(routes, 'GET', '/api/webhooks/stats'))).body).toEqual({
      ok: true,
      activeSubscriptions: 2,
    });
    expect((await invoke(findRoute(routes, 'GET', '/api/webhooks/subscriptions'), {
      query: { provider: 'github' },
    })).body).toEqual({
      ok: true,
      subscriptions: [{ id: 1, secretConfigured: true }],
    });
    expect(registry.getSubscriptions).toHaveBeenCalledWith({ provider: 'github' });

    expect((await invoke(findRoute(routes, 'GET', '/api/webhooks/events'), {
      query: { provider: 'github', status: 'failed', limit: '300' },
    })).body).toEqual({ ok: true, events: [{ id: 2, status: 'failed' }] });
    expect(registry.getRecentEvents).toHaveBeenCalledWith({ provider: 'github', status: 'failed', limit: 200 });

    await invoke(findRoute(routes, 'GET', '/api/webhooks/events'), {
      query: { limit: '-1' },
    });
    expect(registry.getRecentEvents).toHaveBeenLastCalledWith({
      provider: undefined,
      status: undefined,
      limit: 1,
    });

    await invoke(findRoute(routes, 'GET', '/api/webhooks/events'), {
      query: { limit: '1junk' },
    });
    expect(registry.getRecentEvents).toHaveBeenLastCalledWith({
      provider: undefined,
      status: undefined,
      limit: 50,
    });

    await invoke(findRoute(routes, 'GET', '/api/webhooks/events'), {
      query: { limit: ['1', '2'] },
    });
    expect(registry.getRecentEvents).toHaveBeenLastCalledWith({
      provider: undefined,
      status: undefined,
      limit: 50,
    });

    expect((await invoke(findRoute(routes, 'POST', '/api/webhooks/events/:id/replay'), {
      params: { id: '2' },
    })).body).toEqual({ ok: false, message: 'Replay failed' });
    expect(registry.replayEvent).toHaveBeenCalledWith(2, 42);
  });

  it('owner-scopes every webhook management read and mutation', async () => {
    const authorizeTargetUser = vi.fn((req: any, res: any, ownerUserId: number) => {
      if (ownerUserId === 42) return true;
      res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } });
      return false;
    });
    const registry = createRegistry({
      getSubscription: vi.fn((id: number) => ({ id, user_id: id === 7 ? 42 : 77 })),
      getEvent: vi.fn((id: number) => ({ id, user_id: id === 8 ? 42 : 77, status: 'failed' })),
    });
    const routes = captureRoutes({
      config: createConfig(),
      registry,
      logger: createLogger(),
      authorizeTargetUser,
      operatorScopesConfigured: () => true,
    });

    for (const path of ['/api/webhooks/stats', '/api/webhooks/subscriptions', '/api/webhooks/events']) {
      const missingOwner = await invoke(findRoute(routes, 'GET', path), { query: {} });
      expect(missingOwner.statusCode).toBe(400);
      expect(missingOwner.body).toMatchObject({ error: { code: 'OWNER_USER_ID_REQUIRED' } });
    }

    await invoke(findRoute(routes, 'GET', '/api/webhooks/stats'), {
      query: { owner_user_id: '42' },
    });
    expect(registry.getWebhookStats).toHaveBeenCalledWith(42);
    await invoke(findRoute(routes, 'GET', '/api/webhooks/subscriptions'), {
      query: { owner_user_id: '42', provider: 'github' },
    });
    expect(registry.getSubscriptions).toHaveBeenCalledWith({ provider: 'github', user_id: 42 });
    await invoke(findRoute(routes, 'GET', '/api/webhooks/events'), {
      query: { owner_user_id: '42', limit: '10' },
    });
    expect(registry.getRecentEvents).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 42,
      limit: 10,
    }));

    await invoke(findRoute(routes, 'POST', '/api/webhooks/subscriptions'), {
      body: { provider: 'github', owner_user_id: 77, secret: 'out-of-scope' },
    });
    expect(registry.registerSubscription).not.toHaveBeenCalled();
    await invoke(findRoute(routes, 'DELETE', '/api/webhooks/subscriptions/:id'), {
      params: { id: '9' },
    });
    expect(registry.removeSubscription).not.toHaveBeenCalled();
    await invoke(findRoute(routes, 'POST', '/api/webhooks/events/:id/replay'), {
      params: { id: '9' },
    });
    expect(registry.replayEvent).not.toHaveBeenCalled();

    await invoke(findRoute(routes, 'DELETE', '/api/webhooks/subscriptions/:id'), {
      params: { id: '7' },
    });
    expect(registry.removeSubscription).toHaveBeenCalledWith(7, 42);
    await invoke(findRoute(routes, 'POST', '/api/webhooks/events/:id/replay'), {
      params: { id: '8' },
    });
    expect(registry.replayEvent).toHaveBeenCalledWith(8, 42);
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
