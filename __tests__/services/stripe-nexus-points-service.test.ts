import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

const hoisted = vi.hoisted(() => {
  const stripeCreate = vi.fn();
  const stripeRetrieveCharge = vi.fn();
  const stripeConstructEvent = vi.fn();
  const stripeCtor = vi.fn(function StripeMock() {
    return {
      checkout: { sessions: { create: stripeCreate } },
      charges: { retrieve: stripeRetrieveCharge },
      webhooks: { constructEvent: stripeConstructEvent },
    };
  });
  const config = {
    stripe: {
      secretKey: 'sk_test_points',
      webhookSecret: 'whsec_points',
      managedPaymentsSandboxEnabled: true,
      nexusPoints: {
        enabled: true,
        priceIds: {
          small: 'price_points_small',
          medium: 'price_points_medium',
          large: 'price_points_large',
        },
        webSuccessUrl: 'https://nexushub.me/user?nexusPointsCheckout=success',
        webCancelUrl: 'https://nexushub.me/user?nexusPointsCheckout=canceled',
      },
    },
    billing: { paywallEnabled: true },
  };
  return {
    stripeCreate,
    stripeRetrieveCharge,
    stripeConstructEvent,
    stripeCtor,
    config,
    recordOperatorAlert: vi.fn(),
  };
});

vi.mock('stripe', () => ({
  default: hoisted.stripeCtor,
}));

vi.mock('../../src/config', () => ({
  config: hoisted.config,
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
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

vi.mock('../../src/services/user-service', () => ({
  isOwnerUserRef: vi.fn(() => false),
}));

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: (...args: unknown[]) => hoisted.recordOperatorAlert(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  _resetStripeNexusPointsClientForTests,
  createNexusPointsCheckoutSession,
  handleStripeNexusPointsEvent,
  isStripeNexusPointsIdempotencyConflictError,
  processStripeNexusPointsWebhookEvent,
  resolvePackageIdForStripePriceId,
} from '../../src/services/stripe-nexus-points-service';

function createSchema(): void {
  testDb.exec(`
    CREATE TABLE nexus_point_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'purchase',
      provider TEXT NOT NULL,
      product_id TEXT NOT NULL,
      provider_transaction_id TEXT NOT NULL,
      points_granted REAL NOT NULL,
      points_remaining REAL NOT NULL,
      usd_allowance_granted REAL NOT NULL,
      usd_allowance_remaining REAL NOT NULL,
      purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, provider_transaction_id)
    );
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT,
      provider_customer_id TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT
    );
  `);
}

function paidSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_points',
    mode: 'payment',
    payment_status: 'paid',
    payment_intent: 'pi_points_123',
    metadata: {
      userId: '42',
      tenantId: '42',
      packageId: 'me.nexushub.points.small',
      source: 'web',
    },
    line_items: { data: [{ price: { id: 'price_points_small' } }] },
    ...overrides,
  };
}

describe('stripe-nexus-points-service', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    createSchema();
    vi.clearAllMocks();
    hoisted.config.stripe.managedPaymentsSandboxEnabled = true;
    hoisted.config.stripe.nexusPoints.enabled = true;
    hoisted.stripeCreate.mockResolvedValue({ id: 'cs_new', url: 'https://checkout.stripe.test/session' });
    hoisted.stripeRetrieveCharge.mockResolvedValue({ payment_intent: null });
    hoisted.stripeConstructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: paidSession() },
    });
    _resetStripeNexusPointsClientForTests();
  });

  afterEach(() => {
    testDb.close();
  });

  it('creates one-time Checkout Sessions with strict metadata and configured price ids', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T12:34:20Z'));
    try {
      const result = await createNexusPointsCheckoutSession({
        userId: 42,
        tenantId: 42,
        packageId: 'me.nexushub.points.medium',
        source: 'portal',
        note: 'beta tester top-up',
        actor: 'felipe',
      });

      const minuteBucket = Math.floor(Date.now() / 60000);
      expect(result).toEqual({ sessionId: 'cs_new', checkoutUrl: 'https://checkout.stripe.test/session' });
      expect(hoisted.stripeCtor).toHaveBeenCalledWith('sk_test_points', {
        apiVersion: '2026-03-04.preview',
      });
      expect(hoisted.stripeCreate).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'payment',
        line_items: [{ price: 'price_points_medium', quantity: 1 }],
        managed_payments: { enabled: true },
        success_url: 'https://nexushub.me/user?nexusPointsCheckout=success',
        cancel_url: 'https://nexushub.me/user?nexusPointsCheckout=canceled',
        client_reference_id: '42',
        metadata: expect.objectContaining({
          userId: '42',
          tenantId: '42',
          packageId: 'me.nexushub.points.medium',
          source: 'portal',
          actor: 'felipe',
          note: 'beta tester top-up',
        }),
        payment_intent_data: expect.objectContaining({
          metadata: expect.objectContaining({ packageId: 'me.nexushub.points.medium' }),
        }),
      }), {
        idempotencyKey: `nexus-points:42:me.nexushub.points.medium:portal:${minuteBucket}`,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the stable API without Managed Payments when the sandbox flag is disabled', async () => {
    hoisted.config.stripe.managedPaymentsSandboxEnabled = false;
    _resetStripeNexusPointsClientForTests();

    await createNexusPointsCheckoutSession({
      userId: 42,
      tenantId: 42,
      packageId: 'me.nexushub.points.small',
      source: 'web',
    });

    expect(hoisted.stripeCtor).toHaveBeenCalledWith('sk_test_points', {
      apiVersion: '2026-02-25.clover',
    });
    const [checkoutParams] = hoisted.stripeCreate.mock.calls[0];
    expect(checkoutParams).not.toHaveProperty('managed_payments');
  });

  it('dedupes double-click checkout creation with a minute-scoped idempotency key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T12:35:01Z'));
    try {
      await Promise.all([
        createNexusPointsCheckoutSession({
          userId: 42,
          tenantId: 42,
          packageId: 'me.nexushub.points.small',
          source: 'web',
        }),
        createNexusPointsCheckoutSession({
          userId: 42,
          tenantId: 42,
          packageId: 'me.nexushub.points.small',
          source: 'web',
        }),
      ]);

      const [, firstOptions] = hoisted.stripeCreate.mock.calls[0];
      const [, secondOptions] = hoisted.stripeCreate.mock.calls[1];
      expect(firstOptions).toEqual(secondOptions);
      expect(firstOptions.idempotencyKey).toMatch(/^nexus-points:42:me\.nexushub\.points\.small:web:\d+$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps Stripe idempotency conflicts to a typed checkout conflict error', async () => {
    hoisted.stripeCreate.mockRejectedValueOnce({
      type: 'StripeIdempotencyError',
      rawType: 'idempotency_error',
      statusCode: 400,
      message: 'Keys for idempotent requests can only be used with the same parameters.',
    });

    let caught: unknown;
    try {
      await createNexusPointsCheckoutSession({
        userId: 42,
        tenantId: 42,
        packageId: 'me.nexushub.points.small',
        source: 'portal',
        note: 'changed note',
      });
    } catch (err) {
      caught = err;
    }

    expect(isStripeNexusPointsIdempotencyConflictError(caught)).toBe(true);
    expect(caught).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      statusCode: 409,
    });
  });

  it('reuses an existing Stripe customer and otherwise sends user email without logging it', async () => {
    testDb.prepare("INSERT INTO subscriptions (user_id, provider, provider_customer_id, updated_at) VALUES (42, 'stripe', 'cus_existing', datetime('now'))").run();
    await createNexusPointsCheckoutSession({
      userId: 42,
      tenantId: 42,
      packageId: 'me.nexushub.points.small',
      source: 'web',
    });
    expect(hoisted.stripeCreate.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ customer: 'cus_existing' }));

    testDb.prepare("INSERT INTO users (id, email) VALUES (43, 'buyer@example.com')").run();
    await createNexusPointsCheckoutSession({
      userId: 43,
      tenantId: 43,
      packageId: 'me.nexushub.points.small',
      source: 'web',
    });
    expect(hoisted.stripeCreate.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ customer_email: 'buyer@example.com' }));
  });

  it('refuses unknown packages and disabled configuration', async () => {
    await expect(createNexusPointsCheckoutSession({
      userId: 42,
      tenantId: 42,
      packageId: 'bad' as any,
      source: 'web',
    })).rejects.toThrow('UNKNOWN_NEXUS_POINT_PACKAGE');

    hoisted.config.stripe.nexusPoints.enabled = false;
    await expect(createNexusPointsCheckoutSession({
      userId: 42,
      tenantId: 42,
      packageId: 'me.nexushub.points.small',
      source: 'web',
    })).rejects.toThrow('STRIPE_NEXUS_POINTS_NOT_CONFIGURED');
  });

  it('maps Stripe price ids strictly to Nexus Point packages', () => {
    expect(resolvePackageIdForStripePriceId('price_points_small')).toBe('me.nexushub.points.small');
    expect(resolvePackageIdForStripePriceId('price_unknown')).toBeNull();
  });

  it('processes signed paid checkout webhooks and grants points idempotently', async () => {
    await processStripeNexusPointsWebhookEvent(Buffer.from('{}'), 'sig_ok');
    await processStripeNexusPointsWebhookEvent(Buffer.from('{}'), 'sig_ok');

    expect(hoisted.stripeConstructEvent).toHaveBeenCalledWith(Buffer.from('{}'), 'sig_ok', 'whsec_points');
    const rows = testDb.prepare('SELECT provider, provider_transaction_id, product_id, metadata_json FROM nexus_point_credits').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'stripe',
      provider_transaction_id: 'pi_points_123',
      product_id: 'me.nexushub.points.small',
    });
    expect(JSON.parse(rows[0].metadata_json)).toMatchObject({
      sessionId: 'cs_test_points',
      paymentIntentId: 'pi_points_123',
      packageId: 'me.nexushub.points.small',
      source: 'web',
    });
  });

  it('does not grant points for unpaid checkout sessions', async () => {
    await handleStripeNexusPointsEvent({
      type: 'checkout.session.completed',
      data: { object: paidSession({ payment_status: 'unpaid' }) },
    });

    expect(testDb.prepare('SELECT COUNT(*) AS count FROM nexus_point_credits').get()).toEqual({ count: 0 });
  });

  it('recognizes delayed payment failure without granting credits', async () => {
    const handled = await handleStripeNexusPointsEvent({
      type: 'checkout.session.async_payment_failed',
      data: { object: paidSession({ payment_status: 'unpaid' }) },
    });

    expect(handled).toBe(true);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM nexus_point_credits').get()).toEqual({ count: 0 });
  });

  it('ignores unrelated payment-mode Checkout sessions without Nexus Points metadata', async () => {
    const handled = await handleStripeNexusPointsEvent({
      type: 'checkout.session.completed',
      data: { object: paidSession({ metadata: {}, line_items: { data: [{ price: { id: 'price_subscription' } }] } }) },
    });

    expect(handled).toBe(false);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM nexus_point_credits').get()).toEqual({ count: 0 });
    expect(hoisted.recordOperatorAlert).not.toHaveBeenCalled();
  });

  it('grants points on async payment success', async () => {
    await handleStripeNexusPointsEvent({
      type: 'checkout.session.async_payment_succeeded',
      data: { object: paidSession({ payment_intent: 'pi_async_123' }) },
    });

    expect(testDb.prepare('SELECT provider_transaction_id FROM nexus_point_credits').get()).toEqual({ provider_transaction_id: 'pi_async_123' });
  });

  it('rejects unknown Stripe prices with an operator alert', async () => {
    await handleStripeNexusPointsEvent({
      type: 'checkout.session.completed',
      data: { object: paidSession({ line_items: { data: [{ price: { id: 'price_unknown' } }] } }) },
    });

    expect(testDb.prepare('SELECT COUNT(*) AS count FROM nexus_point_credits').get()).toEqual({ count: 0 });
    expect(hoisted.recordOperatorAlert).toHaveBeenCalledWith(expect.objectContaining({
      source: 'stripe_nexus_points',
      dedupeKey: expect.stringContaining('stripe_nexus_checkout_price_mismatch'),
    }));
  });

  it('revokes remaining credits on full refunds and alerts on partial refunds/disputes', async () => {
    await handleStripeNexusPointsEvent({
      type: 'checkout.session.completed',
      data: { object: paidSession({ payment_intent: 'pi_refund_123' }) },
    });

    await handleStripeNexusPointsEvent({
      type: 'charge.refunded',
      data: { object: { id: 'ch_full', payment_intent: 'pi_refund_123', amount: 500, amount_refunded: 500, currency: 'usd' } },
    });
    expect(testDb.prepare('SELECT status, points_remaining FROM nexus_point_credits WHERE provider_transaction_id = ?').get('pi_refund_123')).toEqual({
      status: 'refunded',
      points_remaining: 0,
    });

    await handleStripeNexusPointsEvent({
      type: 'charge.refunded',
      data: { object: { id: 'ch_partial', payment_intent: 'pi_refund_123', amount: 500, amount_refunded: 100, currency: 'usd' } },
    });
    hoisted.stripeRetrieveCharge.mockResolvedValueOnce({ payment_intent: 'pi_refund_123' });
    await handleStripeNexusPointsEvent({
      type: 'charge.dispute.created',
      data: { object: { id: 'du_123', charge: 'ch_partial', amount: 500, currency: 'usd', reason: 'fraudulent', status: 'needs_response' } },
    });

    expect(hoisted.recordOperatorAlert).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'stripe_nexus_partial_refund:ch_partial',
    }));
    expect(hoisted.recordOperatorAlert).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'stripe_nexus_dispute:du_123',
    }));
    expect(hoisted.stripeRetrieveCharge).toHaveBeenCalledWith('ch_partial');
  });

  it('ignores non-Nexus subscription refunds and disputes without operator alerts', async () => {
    hoisted.stripeRetrieveCharge.mockResolvedValueOnce({ payment_intent: 'pi_subscription' });
    await handleStripeNexusPointsEvent({
      type: 'charge.refunded',
      data: { object: { id: 'ch_subscription', payment_intent: 'pi_subscription', amount: 500, amount_refunded: 500, currency: 'usd' } },
    });
    await handleStripeNexusPointsEvent({
      type: 'charge.dispute.created',
      data: { object: { id: 'du_subscription', charge: 'ch_subscription', amount: 500, currency: 'usd' } },
    });
    await handleStripeNexusPointsEvent({
      type: 'charge.refunded',
      data: { object: { id: 'ch_missing_pi', amount: 500, amount_refunded: 500, currency: 'usd' } },
    });

    expect(hoisted.recordOperatorAlert).not.toHaveBeenCalled();
  });

  it('sanitizes portal metadata before sending it to Stripe and storing it in credits', async () => {
    const longNote = `<script>alert(1)</script>\u0000 ${'x'.repeat(400)}`;
    await createNexusPointsCheckoutSession({
      userId: 42,
      tenantId: 42,
      packageId: 'me.nexushub.points.small',
      source: 'portal',
      note: longNote,
      actor: 'felipe\u0007',
    });
    const params = hoisted.stripeCreate.mock.calls.at(-1)?.[0];
    expect(params.metadata.note).not.toContain('\u0000');
    expect(params.metadata.actor).toBe('felipe');
    expect(params.metadata.note).toHaveLength(280);

    await handleStripeNexusPointsEvent({
      type: 'checkout.session.completed',
      data: {
        object: paidSession({
          payment_intent: 'pi_sanitized',
          metadata: {
            userId: '42',
            tenantId: '42',
            packageId: 'me.nexushub.points.small',
            source: 'portal',
            note: params.metadata.note,
            actor: params.metadata.actor,
          },
        }),
      },
    });
    const row = testDb.prepare('SELECT metadata_json FROM nexus_point_credits WHERE provider_transaction_id = ?').get('pi_sanitized') as any;
    const metadata = JSON.parse(row.metadata_json);
    expect(metadata.note).toHaveLength(280);
    expect(metadata.note).toContain('<script>');
    expect(metadata.note).not.toContain('\u0000');
  });
});
