/**
 * Tests for src/api/routes/webhooks.ts
 *
 * Uses supertest against the webhook router (mounted standalone, no full
 * portal server) to verify HMAC signature handling, replay protection, and
 * the immediate-200-then-async-process contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import crypto from 'crypto';
import http from 'http';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

// Mock the config so the webhook secret is deterministic
vi.mock('../../src/config', () => ({
  config: {
    todoist: {
      clientId: 'test_client',
      clientSecret: 'test_secret',
      webhookSecret: 'webhook_test_secret',
    },
    stripe: {
      secretKey: 'sk_test_webhook',
      webhookSecret: 'whsec_test_webhook',
      nexusPoints: { enabled: true },
    },
  },
}));

const serviceMocks = vi.hoisted(() => ({
  syncProvider: vi.fn().mockResolvedValue({ tasksUpserted: 0, errors: [] }),
  invalidateTaskCaches: vi.fn(),
  stripeConstructEvent: vi.fn(),
  stripeCtor: vi.fn(function StripeMock(this: any) {
    this.webhooks = { constructEvent: (...args: unknown[]) => serviceMocks.stripeConstructEvent(...args) };
    return this;
  }),
  handleCheckoutCompleted: vi.fn(),
  handleCheckoutPaymentFailed: vi.fn(),
  fulfillStripeCreditPackCheckout: vi.fn(),
  handleStripeCreditPackReversal: vi.fn(),
  handleSubscriptionUpdated: vi.fn(),
  handleSubscriptionDeleted: vi.fn(),
  handleInvoicePaid: vi.fn(),
  handleInvoicePaymentFailed: vi.fn(),
  hasProcessedStripeWebhookEvent: vi.fn(),
  markStripeWebhookEventProcessed: vi.fn(),
  handleStripeNexusPointsEvent: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: serviceMocks.stripeCtor,
}));

vi.mock('../../src/services/stripe-service', () => ({
  isStripeConfigured: vi.fn(() => true),
  handleCheckoutCompleted: (...args: unknown[]) => serviceMocks.handleCheckoutCompleted(...args),
  handleCheckoutPaymentFailed: (...args: unknown[]) => serviceMocks.handleCheckoutPaymentFailed(...args),
  fulfillStripeCreditPackCheckout: (...args: unknown[]) => serviceMocks.fulfillStripeCreditPackCheckout(...args),
  handleStripeCreditPackReversal: (...args: unknown[]) => serviceMocks.handleStripeCreditPackReversal(...args),
  handleSubscriptionUpdated: (...args: unknown[]) => serviceMocks.handleSubscriptionUpdated(...args),
  handleSubscriptionDeleted: (...args: unknown[]) => serviceMocks.handleSubscriptionDeleted(...args),
  handleInvoicePaid: (...args: unknown[]) => serviceMocks.handleInvoicePaid(...args),
  handleInvoicePaymentFailed: (...args: unknown[]) => serviceMocks.handleInvoicePaymentFailed(...args),
  hasProcessedStripeWebhookEvent: (...args: unknown[]) => serviceMocks.hasProcessedStripeWebhookEvent(...args),
  markStripeWebhookEventProcessed: (...args: unknown[]) => serviceMocks.markStripeWebhookEventProcessed(...args),
}));

vi.mock('../../src/services/stripe-nexus-points-service', () => ({
  handleStripeNexusPointsEvent: (...args: unknown[]) => serviceMocks.handleStripeNexusPointsEvent(...args),
}));

// Mock the dependent services so the async processor doesn't crash
vi.mock('../../src/services/database', () => ({ getDb: () => ({ prepare: () => ({ all: () => [] }) })  ,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));
vi.mock('../../src/services/task-store/sync-engine', () => ({
  syncProvider: (...args: unknown[]) => serviceMocks.syncProvider(...args),
}));
vi.mock('../../src/services/task-store/todoist-adapter', () => ({
  findNexusUserByTodoistId: vi.fn().mockReturnValue(123),
  rememberTodoistUserMapping: vi.fn(),
}));
vi.mock('../../src/services/cache-coherence-registry', () => ({
  ...{
    CacheCoherenceEvents: {},
    _resetDashboardCacheInvalidationStatsForTests: vi.fn(),
    getDashboardCacheInvalidationStats: vi.fn(),
    invalidateCacheForEvent: vi.fn(),
    invalidateCalendarCaches: vi.fn(),
    invalidateContentDerivedCaches: vi.fn(),
    invalidateCookingDerivedCaches: vi.fn(),
    invalidateDashboardCaches: vi.fn(),
    invalidateDashboardCoordinationCaches: vi.fn(),
    invalidateDashboardHomeCaches: vi.fn(),
    invalidateDashboardReadinessCaches: vi.fn(),
    invalidateDashboardRootCaches: vi.fn(),
    invalidateExecutiveBriefCaches: vi.fn(),
    invalidateFinanceDerivedCaches: vi.fn(),
    invalidateIntegrationDerivedCaches: vi.fn(),
    invalidateOnboardingDerivedCaches: vi.fn(),
    invalidatePlanningCaches: vi.fn(),
    invalidateTaskCaches: vi.fn(),
    invalidateTrainingDerivedCaches: vi.fn(),
  },
  invalidateTaskCaches: (...args: unknown[]) => serviceMocks.invalidateTaskCaches(...args),
}));

import {
  createWebhookRouter,
  processTodoistEvent,
  todoistWebhookRateLimitMiddleware,
  verifyTodoistSignature,
  _resetDeliveryCacheForTests,
} from '../../src/api/routes/webhooks';
import { config } from '../../src/config';

const TODOIST_ROUTER_SECRET = 'isolated_todoist_webhook_test_secret';

function buildSignature(rawBody: string): string {
  return crypto.createHmac('sha256', TODOIST_ROUTER_SECRET).update(rawBody).digest('base64');
}

/** Spin up a minimal Express server with the webhook router and POST a request. */
async function postWebhook(opts: {
  body: any;
  signature?: string;
  deliveryId?: string;
  useConfiguredSecret?: boolean;
}): Promise<{ status: number; body: any }> {
  const app = express();
  app.use(
    '/webhooks',
    opts.useConfiguredSecret
      ? createWebhookRouter()
      : createWebhookRouter({ todoistWebhookSecret: TODOIST_ROUTER_SECRET }),
  );

  const server = app.listen(0);
  const address = server.address() as { port: number };
  const port = address.port;

  const rawBody = JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(rawBody)),
  };
  if (opts.signature !== undefined) headers['X-Todoist-Hmac-SHA256'] = opts.signature;
  if (opts.deliveryId !== undefined) headers['X-Todoist-Delivery-Id'] = opts.deliveryId;

  const response = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/webhooks/todoist',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: data ? JSON.parse(data) : null });
          } catch {
            resolve({ status: res.statusCode || 0, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
  return response;
}

beforeEach(() => {
  _resetDeliveryCacheForTests();
  serviceMocks.syncProvider.mockClear();
  serviceMocks.invalidateTaskCaches.mockClear();
  serviceMocks.stripeConstructEvent.mockReset();
  serviceMocks.handleCheckoutCompleted.mockReset();
  serviceMocks.handleCheckoutPaymentFailed.mockReset();
  serviceMocks.fulfillStripeCreditPackCheckout.mockReset();
  serviceMocks.handleStripeCreditPackReversal.mockReset();
  serviceMocks.handleSubscriptionUpdated.mockReset();
  serviceMocks.handleSubscriptionDeleted.mockReset();
  serviceMocks.handleInvoicePaid.mockReset();
  serviceMocks.handleInvoicePaymentFailed.mockReset();
  serviceMocks.hasProcessedStripeWebhookEvent.mockReset();
  serviceMocks.hasProcessedStripeWebhookEvent.mockReturnValue(false);
  serviceMocks.markStripeWebhookEventProcessed.mockReset();
  serviceMocks.handleStripeNexusPointsEvent.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── verifyTodoistSignature ─────────────────────────────────────────

describe('verifyTodoistSignature', () => {
  it('accepts a correctly-signed body', () => {
    const body = Buffer.from('{"test":"data"}');
    const sig = crypto.createHmac('sha256', TODOIST_ROUTER_SECRET).update(body).digest('base64');
    expect(verifyTodoistSignature(body, sig, TODOIST_ROUTER_SECRET)).toBe(true);
  });

  it('rejects an empty signature', () => {
    expect(verifyTodoistSignature(Buffer.from('x'), '', TODOIST_ROUTER_SECRET)).toBe(false);
  });

  it('rejects a wrong signature', () => {
    expect(verifyTodoistSignature(Buffer.from('x'), 'AAAAAAAAAAAAAAAAAAAAAAAA', TODOIST_ROUTER_SECRET)).toBe(false);
  });

  it('rejects an empty secret', () => {
    expect(verifyTodoistSignature(Buffer.from('x'), 'whatever', '')).toBe(false);
  });

  it('uses constant-time comparison (no length leak)', () => {
    const body = Buffer.from('{"a":1}');
    const correct = crypto.createHmac('sha256', TODOIST_ROUTER_SECRET).update(body).digest('base64');
    // Wrong but same length
    const wrongSameLength = correct.split('').reverse().join('');
    expect(verifyTodoistSignature(body, wrongSameLength, TODOIST_ROUTER_SECRET)).toBe(false);
  });
});

// ── POST /webhooks/todoist ─────────────────────────────────────────

describe('POST /webhooks/todoist', () => {
  it('runs its route-local limiter before parsing or HMAC authorization', () => {
    const router = createWebhookRouter({ todoistWebhookSecret: TODOIST_ROUTER_SECRET });
    const todoistRoute = router.stack.find((layer: any) => layer.route?.path === '/todoist');
    expect(todoistRoute?.route.stack[0]?.handle).toBe(todoistWebhookRateLimitMiddleware);
  });

  it('returns 200 for a valid signature', async () => {
    const body = { event_name: 'item:added', user_id: 555, event_data: {} };
    const sig = buildSignature(JSON.stringify(body));
    const res = await postWebhook({ body, signature: sig, deliveryId: 'd1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('uses the configured secret when no router override is provided', async () => {
    const body = { event_name: 'item:added', user_id: 555, event_data: {} };
    const rawBody = JSON.stringify(body);
    const signature = crypto
      .createHmac('sha256', config.todoist.webhookSecret)
      .update(rawBody)
      .digest('base64');

    const res = await postWebhook({
      body,
      signature,
      deliveryId: 'configured_secret_d1',
      useConfiguredSecret: true,
    });

    expect(res).toEqual({ status: 200, body: { ok: true } });
  });

  it('invalidates task, Home, and plan surfaces after a valid Todoist sync', async () => {
    await processTodoistEvent({
      event_name: 'item:updated',
      user_id: 555,
      event_data: { id: 'task-1' },
    });

    expect(serviceMocks.syncProvider).toHaveBeenCalledWith(123, 'todoist');
    expect(serviceMocks.invalidateTaskCaches).toHaveBeenCalledWith({
      userId: 123,
      includeDerivedSurfaces: true,
    });
  });

  it('returns 401 for an invalid signature', async () => {
    const body = { event_name: 'item:added', user_id: 555 };
    const res = await postWebhook({
      body,
      signature: 'AAAAAAAAAAAAAAAAAAAAAAAA',
      deliveryId: 'd2',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid signature/);
  });

  it('returns 401 for a missing signature header', async () => {
    const body = { event_name: 'item:added' };
    const res = await postWebhook({ body, deliveryId: 'd3' });
    expect(res.status).toBe(401);
  });

  it('dedups duplicate delivery IDs (returns 200 with dedup flag)', async () => {
    const body = { event_name: 'item:added', user_id: 555 };
    const sig = buildSignature(JSON.stringify(body));

    const first = await postWebhook({ body, signature: sig, deliveryId: 'dup_test' });
    expect(first.status).toBe(200);
    expect(first.body.dedup).toBeUndefined();

    const second = await postWebhook({ body, signature: sig, deliveryId: 'dup_test' });
    expect(second.status).toBe(200);
    expect(second.body.dedup).toBe(true);
  });

  it('returns 400 for malformed JSON (after passing HMAC)', async () => {
    // Sign the literal "not json" string so HMAC passes; then the parser fails
    const rawBody = 'not json';
    const sig = crypto.createHmac('sha256', TODOIST_ROUTER_SECRET).update(Buffer.from(rawBody)).digest('base64');

    const app = express();
    app.use('/webhooks', createWebhookRouter({ todoistWebhookSecret: TODOIST_ROUTER_SECRET }));
    const server = app.listen(0);
    const port = (server.address() as any).port;

    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1', port, method: 'POST', path: '/webhooks/todoist',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(rawBody)),
            'X-Todoist-Hmac-SHA256': sig,
            'X-Todoist-Delivery-Id': 'malformed_test',
          },
        },
        (response) => {
          let data = '';
          response.on('data', (c) => (data += c));
          response.on('end', () => {
            try { resolve({ status: response.statusCode || 0, body: JSON.parse(data) }); }
            catch { resolve({ status: response.statusCode || 0, body: data }); }
          });
        },
      );
      req.on('error', reject);
      req.write(rawBody);
      req.end();
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(res.status).toBe(400);
  });
});

async function postStripeWebhook(rawBody: string, signature = 'sig_test'): Promise<{ status: number; body: any }> {
  const app = express();
  app.use('/webhooks', createWebhookRouter());

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const response = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/webhooks/stripe',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(rawBody)),
          'Stripe-Signature': signature,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve({ status: res.statusCode || 0, body: data ? JSON.parse(data) : null }); }
          catch { resolve({ status: res.statusCode || 0, body: data }); }
        });
      },
    );
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return response;
}

describe('POST /webhooks/stripe', () => {
  it('routes Nexus Points checkout events before subscription fallback', async () => {
    const event = { id: 'evt_points', type: 'checkout.session.completed', data: { object: { id: 'cs_points', mode: 'payment' } } };
    serviceMocks.stripeConstructEvent.mockReturnValue(event);
    serviceMocks.handleStripeNexusPointsEvent.mockResolvedValue(true);

    const res = await postStripeWebhook(JSON.stringify({ id: 'evt_points' }));
    expect(res.status).toBe(200);
    expect(serviceMocks.stripeConstructEvent).toHaveBeenCalledWith(expect.any(Buffer), 'sig_test', 'whsec_test_webhook');
    expect(serviceMocks.handleStripeNexusPointsEvent).toHaveBeenCalledWith(event);
    expect(serviceMocks.handleCheckoutCompleted).not.toHaveBeenCalled();
  });

  it('reverses a credit-pack session when its async payment fails', async () => {
    const session = { id: 'cs_pack_async_fail', mode: 'payment', payment_intent: 'pi_async_fail', metadata: { catalogItemId: 'pack_100' } };
    const event = { id: 'evt_async_fail', type: 'checkout.session.async_payment_failed', data: { object: session } };
    serviceMocks.stripeConstructEvent.mockReturnValue(event);
    serviceMocks.handleStripeNexusPointsEvent.mockResolvedValue(false);

    const res = await postStripeWebhook(JSON.stringify({ id: 'evt_async_fail' }));

    expect(res.status).toBe(200);
    expect(serviceMocks.handleStripeCreditPackReversal).toHaveBeenCalledWith(
      { payment_intent: 'pi_async_fail', refunded: true },
      'refund',
    );
  });

  it('fulfills credit-pack sessions on the synchronous completed event', async () => {
    const session = { id: 'cs_pack', mode: 'payment', payment_status: 'paid', metadata: { catalogItemId: 'pack_100' } };
    const event = { id: 'evt_pack', type: 'checkout.session.completed', data: { object: session } };
    serviceMocks.stripeConstructEvent.mockReturnValue(event);
    serviceMocks.handleStripeNexusPointsEvent.mockResolvedValue(false);

    const res = await postStripeWebhook(JSON.stringify({ id: 'evt_pack' }));

    expect(res.status).toBe(200);
    expect(serviceMocks.fulfillStripeCreditPackCheckout).toHaveBeenCalledWith(session);
    expect(serviceMocks.handleCheckoutCompleted).not.toHaveBeenCalled();
  });

  it('preserves subscription checkout handling when Nexus Points handler declines the event', async () => {
    const session = { id: 'cs_sub', mode: 'subscription' };
    const event = { id: 'evt_sub', type: 'checkout.session.completed', data: { object: session } };
    serviceMocks.stripeConstructEvent.mockReturnValue(event);
    serviceMocks.handleStripeNexusPointsEvent.mockResolvedValue(false);

    const res = await postStripeWebhook(JSON.stringify({ id: 'evt_sub' }));

    expect(res.status).toBe(200);
    expect(serviceMocks.handleCheckoutCompleted).toHaveBeenCalledWith(session);
  });

  it('activates delayed subscription checkout only after async payment succeeds', async () => {
    const session = { id: 'cs_delayed_sub', mode: 'subscription', payment_status: 'paid' };
    const event = { id: 'evt_delayed_sub', type: 'checkout.session.async_payment_succeeded', data: { object: session } };
    serviceMocks.stripeConstructEvent.mockReturnValue(event);
    serviceMocks.handleStripeNexusPointsEvent.mockResolvedValue(false);

    const res = await postStripeWebhook(JSON.stringify({ id: event.id }));

    expect(res.status).toBe(200);
    expect(serviceMocks.handleCheckoutCompleted).toHaveBeenCalledWith(session);
  });

  it('records failed delayed subscription checkout without activating it', async () => {
    const session = { id: 'cs_failed_sub', mode: 'subscription', payment_status: 'unpaid' };
    const event = { id: 'evt_failed_sub', type: 'checkout.session.async_payment_failed', data: { object: session } };
    serviceMocks.stripeConstructEvent.mockReturnValue(event);

    const res = await postStripeWebhook(JSON.stringify({ id: event.id }));

    expect(res.status).toBe(200);
    expect(serviceMocks.handleStripeNexusPointsEvent).toHaveBeenCalledWith(event);
    expect(serviceMocks.handleCheckoutPaymentFailed).toHaveBeenCalledWith(session);
    expect(serviceMocks.handleCheckoutCompleted).not.toHaveBeenCalled();
  });

  it('restores an existing Stripe subscription after invoice payment recovery', async () => {
    const invoice = { id: 'in_paid', customer: 'cus_paid' };
    const event = { id: 'evt_invoice_paid', type: 'invoice.paid', data: { object: invoice } };
    serviceMocks.stripeConstructEvent.mockReturnValue(event);

    const res = await postStripeWebhook(JSON.stringify({ id: event.id }));

    expect(res.status).toBe(200);
    expect(serviceMocks.handleInvoicePaid).toHaveBeenCalledWith(invoice);
  });

  it('returns 400 for invalid Stripe signatures', async () => {
    serviceMocks.stripeConstructEvent.mockImplementation(() => {
      throw new Error('bad signature');
    });

    const res = await postStripeWebhook(JSON.stringify({ id: 'evt_bad' }), 'bad_sig');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Webhook signature verification failed/);
  });

  it('returns 500 for valid Stripe events that fail during processing', async () => {
    const event = { id: 'evt_processing', type: 'charge.dispute.created', data: { object: { id: 'du_1' } } };
    serviceMocks.stripeConstructEvent.mockReturnValue(event);
    serviceMocks.handleStripeNexusPointsEvent.mockRejectedValue(new Error('database temporarily unavailable'));

    const res = await postStripeWebhook(JSON.stringify({ id: 'evt_processing' }));

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/processing failed/);
  });
});
