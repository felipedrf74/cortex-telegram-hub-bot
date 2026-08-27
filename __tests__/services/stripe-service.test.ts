import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { hashEmail } from '../../src/utils/identity';

let testDb: Database.Database;
const TEST_IOS_JWT_SECRET = 'test-ios-jwt-secret-at-least-32-bytes-long';

function appleGrantContext(userId: number, environment = 'Production') {
  const body = Buffer.alloc(5);
  body.writeUInt8(0x01, 0);
  body.writeUInt32BE(userId, 1);
  const tag = crypto.createHmac('sha256', TEST_IOS_JWT_SECRET).update(body).digest().subarray(0, 11);
  const hex = Buffer.concat([body, tag]).toString('hex');
  return {
    tenantId: userId,
    environment,
    appAccountToken: [
      hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
    ].join('-'),
  };
}

const hoisted = vi.hoisted(() => {
  const stripeConfig = {
    secretKey: 'sk_test',
    webhookSecret: 'whsec_test',
    expectedAccountId: 'acct_expectedtest',
    managedPaymentsSandboxEnabled: true,
    historicalPriceProMonthly: 'price_historical_pro_operator',
    historicalPriceMaxMonthly: 'price_historical_max_operator',
    priceProYearly: '',
    priceMaxYearly: '',
    priceProMonthlyBrl: 'price_pro_brl',
    priceProYearlyBrl: '',
    priceMaxMonthlyBrl: 'price_max_brl',
    priceMaxYearlyBrl: '',
    priceProMonthlyEur: '',
    priceProYearlyEur: '',
    priceMaxMonthlyEur: '',
    priceMaxYearlyEur: '',
  };
  const claimWindowNow = Date.now();
  const claimWindow = {
    enabled: true,
    startedAt: new Date(claimWindowNow - 24 * 60 * 60 * 1000).toISOString(),
    sunsetAt: new Date(claimWindowNow + 29 * 24 * 60 * 60 * 1000).toISOString(),
  };
  return {
    stripeConfig,
    claimWindow,
    loggerWarn: vi.fn(),
    loggerInfo: vi.fn(),
    loggerError: vi.fn(),
    sendPaymentReceipt: vi.fn(),
    sendPaymentFailed: vi.fn(),
    sendCancellationConfirmation: vi.fn(),
    stripeCheckoutCreate: vi.fn(),
    stripePortalCreate: vi.fn(),
    stripeAccountRetrieve: vi.fn(async () => ({ id: 'acct_expectedtest' })),
    stripeCtor: vi.fn(function StripeMock() {
      return {
        accounts: { retrieve: hoisted.stripeAccountRetrieve },
        checkout: { sessions: { create: hoisted.stripeCheckoutCreate } },
        billingPortal: { sessions: { create: hoisted.stripePortalCreate } },
      };
    }),
  };
});

vi.mock('stripe', () => ({
  default: hoisted.stripeCtor,
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: hoisted.stripeConfig,
    hybridCommerce: {
      subscriptionCheckoutEnabled: true,
      get anonymousCheckoutClaimEnabled() { return hoisted.claimWindow.enabled; },
      get anonymousCheckoutClaimWindowStartedAt() { return hoisted.claimWindow.startedAt; },
      get anonymousCheckoutClaimSunsetAt() { return hoisted.claimWindow.sunsetAt; },
      stripePriceIds: {
        planProMonthly: 'price_pro_usd',
        planMaxMonthly: 'price_max_usd',
        pack100: '',
        pack250: '',
        pack600: '',
      },
    },
    ios: {
      jwtSecret: 'test-ios-jwt-secret-at-least-32-bytes-long',
      appAccountTokenHmacSecret: 'test-ios-jwt-secret-at-least-32-bytes-long',
    },
  },
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: (...args: unknown[]) => hoisted.loggerInfo(...args),
    warn: (...args: unknown[]) => hoisted.loggerWarn(...args),
    error: (...args: unknown[]) => hoisted.loggerError(...args),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/email-sender', () => ({
  sendPaymentReceipt: (...args: unknown[]) => hoisted.sendPaymentReceipt(...args),
  sendPaymentFailed: (...args: unknown[]) => hoisted.sendPaymentFailed(...args),
  sendCancellationConfirmation: (...args: unknown[]) => hoisted.sendCancellationConfirmation(...args),
}));

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      first_name TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      tier TEXT NOT NULL DEFAULT 'free'
    );

    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      plan TEXT NOT NULL DEFAULT 'free',
      period TEXT NOT NULL DEFAULT 'monthly',
      status TEXT NOT NULL DEFAULT 'inactive',
      provider TEXT NOT NULL DEFAULT 'none',
      provider_subscription_id TEXT,
      provider_customer_id TEXT,
      current_period_start TEXT,
      current_period_end TEXT,
      environment TEXT,
      cancel_at_period_end INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE stripe_web_checkouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      email_hash TEXT NOT NULL,
      plan TEXT NOT NULL,
      currency TEXT NOT NULL,
      price_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      stripe_checkout_session_id TEXT UNIQUE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE stripe_webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE apple_webhook_events (
      notification_uuid TEXT PRIMARY KEY,
      notification_type TEXT NOT NULL,
      subtype TEXT,
      environment TEXT,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Build the inner `signedTransactionInfo` JWS of an App Store Server
 * Notification. Only the payload segment is read by the handler — the outer
 * envelope's signature is verified in the route, not here.
 */
function appleTransactionJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ bundleId: 'me.nexushub.app', ...payload })).toString('base64url');
  const sig = Buffer.from('stub-signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

describe('stripe service billing reconciliation', () => {
  beforeEach(() => {
    // This suite legitimately exercises sandbox checkout flows with a test
    // key; the QA3 P1-2 key-mode gate is opted out explicitly here.
    vi.stubEnv('STRIPE_SANDBOX_CHECKOUT_ALLOWED', 'true');
    testDb = new Database(':memory:');
    createSchema(testDb);
    hoisted.stripeConfig.managedPaymentsSandboxEnabled = true;
    hoisted.stripeConfig.expectedAccountId = 'acct_expectedtest';
    hoisted.stripeConfig.historicalPriceProMonthly = 'price_historical_pro_operator';
    hoisted.stripeConfig.historicalPriceMaxMonthly = 'price_historical_max_operator';
    const claimWindowNow = Date.now();
    hoisted.claimWindow.enabled = true;
    hoisted.claimWindow.startedAt = new Date(
      claimWindowNow - 24 * 60 * 60 * 1000,
    ).toISOString();
    hoisted.claimWindow.sunsetAt = new Date(
      claimWindowNow + 29 * 24 * 60 * 60 * 1000,
    ).toISOString();
    hoisted.stripeCtor.mockClear();
    hoisted.loggerWarn.mockReset();
    hoisted.loggerInfo.mockReset();
    hoisted.loggerError.mockReset();
    hoisted.sendPaymentReceipt.mockReset();
    hoisted.sendPaymentReceipt.mockResolvedValue(true);
    hoisted.sendPaymentFailed.mockReset();
    hoisted.sendPaymentFailed.mockResolvedValue(true);
    hoisted.sendCancellationConfirmation.mockReset();
    hoisted.sendCancellationConfirmation.mockResolvedValue(true);
    hoisted.stripeCheckoutCreate.mockReset();
    hoisted.stripeCheckoutCreate.mockResolvedValue({ id: 'cs_checkout', url: 'https://checkout.stripe.test/session' });
    hoisted.stripePortalCreate.mockReset();
    hoisted.stripeAccountRetrieve.mockReset();
    hoisted.stripeAccountRetrieve.mockResolvedValue({ id: 'acct_expectedtest' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDb.close();
  });

  it('creates Managed Payments Checkout with the selected plan metadata', async () => {
    const {
      _resetStripeClientForTests,
      createCheckoutSessionForPlan,
    } = await import('../../src/services/stripe-service');
    _resetStripeClientForTests();

    const url = await createCheckoutSessionForPlan(
      42,
      'max',
      'usd',
      'https://nexushub.me/user?checkout=success',
      'https://nexushub.me/user?checkout=canceled',
    );

    expect(url).toBe('https://checkout.stripe.test/session');
    expect(hoisted.stripeCtor).toHaveBeenCalledWith('sk_test', {
      apiVersion: '2026-03-04.preview',
    });
    expect(hoisted.stripeCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'subscription',
      automatic_tax: { enabled: true },
      line_items: [{ price: 'price_max_usd', quantity: 1 }],
      managed_payments: { enabled: true },
      metadata: expect.objectContaining({ userId: '42', plan: 'max', currency: 'usd' }),
      subscription_data: {
        metadata: expect.objectContaining({ userId: '42', plan: 'max', currency: 'usd' }),
      },
    }));
    const [checkoutParams] = hoisted.stripeCheckoutCreate.mock.calls[0];
    expect(checkoutParams).not.toHaveProperty('customer_creation');
  });

  it('keeps preview API and Managed Payments parameters off when the sandbox flag is disabled', async () => {
    const {
      _resetStripeClientForTests,
      createCheckoutSessionForPlan,
    } = await import('../../src/services/stripe-service');
    hoisted.stripeConfig.managedPaymentsSandboxEnabled = false;
    _resetStripeClientForTests();

    await createCheckoutSessionForPlan(
      42,
      'pro',
      'usd',
      'https://nexushub.me/user?checkout=success',
      'https://nexushub.me/user?checkout=canceled',
    );

    expect(hoisted.stripeCtor).toHaveBeenCalledWith('sk_test', {
      apiVersion: '2026-03-25.dahlia',
    });
    const [checkoutParams] = hoisted.stripeCheckoutCreate.mock.calls[0];
    expect(checkoutParams).not.toHaveProperty('managed_payments');
  });

  it('refuses checkout when the secret key belongs to a different Stripe account', async () => {
    const {
      _resetStripeClientForTests,
      createCheckoutSessionForPlan,
      StripeAccountBindingError,
    } = await import('../../src/services/stripe-service');
    hoisted.stripeAccountRetrieve.mockResolvedValue({ id: 'acct_wrong' });
    _resetStripeClientForTests();

    await expect(createCheckoutSessionForPlan(
      42,
      'pro',
      'usd',
      'https://nexushub.me/user?checkout=success',
      'https://nexushub.me/user?checkout=canceled',
    )).rejects.toBeInstanceOf(StripeAccountBindingError);
    expect(hoisted.stripeCheckoutCreate).not.toHaveBeenCalled();
  });

  it('fails closed when Stripe cannot prove the configured account binding', async () => {
    const {
      _resetStripeClientForTests,
      createCheckoutSessionForPlan,
      StripeAccountBindingError,
    } = await import('../../src/services/stripe-service');
    hoisted.stripeAccountRetrieve.mockRejectedValue(new Error('provider unavailable'));
    _resetStripeClientForTests();

    await expect(createCheckoutSessionForPlan(
      42,
      'pro',
      'usd',
      'https://nexushub.me/user?checkout=success',
      'https://nexushub.me/user?checkout=canceled',
    )).rejects.toBeInstanceOf(StripeAccountBindingError);
    expect(hoisted.stripeCheckoutCreate).not.toHaveBeenCalled();
  });

  it('maps Checkout provider failures to a controlled unavailable error', async () => {
    const {
      _resetStripeClientForTests,
      createCheckoutSessionForPlan,
      StripeCheckoutProviderError,
    } = await import('../../src/services/stripe-service');
    hoisted.stripeCheckoutCreate.mockRejectedValueOnce({
      type: 'StripeInvalidRequestError',
      code: 'tax_settings_incomplete',
      statusCode: 400,
      requestId: 'req_safe123',
      message: 'provider detail must remain private',
      raw: { sensitive: 'provider response' },
    });
    _resetStripeClientForTests();

    await expect(createCheckoutSessionForPlan(
      42,
      'pro',
      'usd',
      'https://nexushub.me/user?checkout=success',
      'https://nexushub.me/user?checkout=canceled',
    )).rejects.toBeInstanceOf(StripeCheckoutProviderError);
    const diagnosticPayload = hoisted.loggerError.mock.calls.find(
      ([, message]) => message === 'Stripe Checkout failed closed',
    )?.[0] as Record<string, unknown>;
    expect(diagnosticPayload).toMatchObject({
      stripeErrorType: 'StripeInvalidRequestError',
      stripeErrorCode: 'tax_settings_incomplete',
      stripeStatusCode: 400,
      stripeRequestId: 'req_safe123',
    });
    expect(diagnosticPayload).not.toHaveProperty('message');
    expect(diagnosticPayload).not.toHaveProperty('raw');
  });

  it('refuses credit-pack checkout when the secret key belongs to a different Stripe account', async () => {
    const {
      _resetStripeClientForTests,
      createCreditPackCheckoutSession,
      StripeAccountBindingError,
    } = await import('../../src/services/stripe-service');
    hoisted.stripeAccountRetrieve.mockResolvedValue({ id: 'acct_wrong' });
    _resetStripeClientForTests();

    await expect(createCreditPackCheckoutSession(
      42,
      { catalogItemId: 'pack.credits.100', priceId: 'price_pack_100' },
      'https://nexushub.me/user?checkout=success',
      'https://nexushub.me/user?checkout=canceled',
    )).rejects.toBeInstanceOf(StripeAccountBindingError);
    expect(hoisted.stripeCheckoutCreate).not.toHaveBeenCalled();
  });

  it('enables automatic tax and refreshes the address of a reused credit-pack customer', async () => {
    const {
      _resetStripeClientForTests,
      createCreditPackCheckoutSession,
    } = await import('../../src/services/stripe-service');
    testDb.prepare(`
      INSERT INTO subscriptions (user_id, plan, status, provider, provider_customer_id)
      VALUES (42, 'pro', 'active', 'stripe', 'cus_existing')
    `).run();
    _resetStripeClientForTests();

    await createCreditPackCheckoutSession(
      42,
      { catalogItemId: 'pack.credits.100', priceId: 'price_pack_100' },
      'https://nexushub.me/user?checkout=success',
      'https://nexushub.me/user?checkout=canceled',
    );

    expect(hoisted.stripeCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment',
      automatic_tax: { enabled: true },
      customer: 'cus_existing',
      customer_update: { address: 'auto' },
    }));
  });

  it('creates public Managed Payments Checkout and stores the unclaimed purchase', async () => {
    const {
      _resetStripeClientForTests,
      createPublicCheckoutSession,
    } = await import('../../src/services/stripe-service');
    _resetStripeClientForTests();

    await createPublicCheckoutSession({
      email: 'buyer@example.com',
      plan: 'pro',
      currency: 'usd',
      successUrl: 'https://nexushub.me/?checkout=success',
      cancelUrl: 'https://nexushub.me/?checkout=canceled',
    });

    expect(hoisted.stripeCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'subscription',
      automatic_tax: { enabled: true },
      managed_payments: { enabled: true },
      line_items: [{ price: 'price_pro_usd', quantity: 1 }],
      metadata: expect.objectContaining({ plan: 'pro', currency: 'usd', source: 'website' }),
    }));
    expect(testDb.prepare(`
      SELECT plan, currency, price_id, status, user_id
      FROM stripe_web_checkouts
      WHERE stripe_checkout_session_id = 'cs_checkout'
    `).get()).toEqual({
      plan: 'pro',
      currency: 'usd',
      price_id: 'price_pro_usd',
      status: 'created',
      user_id: null,
    });
  });

  it('routes retained BRL checkout requests through the USD Adaptive Pricing reference price', async () => {
    const { resolveStripePriceId } = await import('../../src/services/stripe-service');

    expect(resolveStripePriceId('pro', 'brl')).toBe('price_pro_usd');
    expect(resolveStripePriceId('max', 'brl')).toBe('price_max_usd');
  });

  it('does not activate a subscription until Checkout reports a settled payment', async () => {
    const { handleCheckoutCompleted } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare(
      'INSERT INTO users (email, email_verified) VALUES (?, 1)',
    ).run('delayed@example.com').lastInsertRowid);

    const session = {
      id: 'sess_delayed',
      mode: 'subscription',
      payment_status: 'unpaid',
      subscription: 'sub_delayed',
      customer: 'cus_delayed',
      metadata: { userId: String(userId), plan: 'max', currency: 'usd' },
    };
    handleCheckoutCompleted(session);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM subscriptions').get()).toEqual({ count: 0 });

    handleCheckoutCompleted({ ...session, payment_status: 'paid' });
    expect(testDb.prepare('SELECT plan, status FROM subscriptions WHERE user_id = ?').get(userId)).toEqual({
      plan: 'max',
      status: 'active',
    });
  });

  it('keeps an unpaid public checkout unclaimable and records delayed failure', async () => {
    const {
      handleCheckoutCompleted,
      handleCheckoutPaymentFailed,
      handleSubscriptionUpdated,
    } = await import('../../src/services/stripe-service');
    testDb.prepare(`
      INSERT INTO stripe_web_checkouts (
        email, email_hash, plan, currency, price_id, status, stripe_checkout_session_id
      ) VALUES (?, ?, 'pro', 'usd', 'price_pro_usd', 'created', 'sess_public_delayed')
    `).run('delayed-public@example.com', hashEmail('delayed-public@example.com'));
    const session = {
      id: 'sess_public_delayed',
      mode: 'subscription',
      payment_status: 'unpaid',
      subscription: 'sub_public_delayed',
      customer: 'cus_public_delayed',
      metadata: { email: 'delayed-public@example.com', plan: 'pro', currency: 'usd' },
    };

    handleCheckoutCompleted(session);
    expect(testDb.prepare('SELECT status FROM stripe_web_checkouts').get()).toEqual({ status: 'pending' });

    handleSubscriptionUpdated({
      id: 'sub_public_delayed',
      customer: 'cus_public_delayed',
      status: 'active',
      metadata: { email: 'delayed-public@example.com', plan: 'pro', currency: 'usd' },
      items: { data: [{ price: { id: 'price_pro_usd' } }] },
      cancel_at_period_end: false,
    });
    expect(testDb.prepare('SELECT status FROM stripe_web_checkouts').get()).toEqual({ status: 'incomplete' });

    handleCheckoutPaymentFailed(session);
    expect(testDb.prepare('SELECT status FROM stripe_web_checkouts').get()).toEqual({ status: 'payment_failed' });

    handleSubscriptionUpdated({
      id: 'sub_public_delayed',
      customer: 'cus_public_delayed',
      status: 'active',
      metadata: { email: 'delayed-public@example.com', plan: 'pro', currency: 'usd' },
      items: { data: [{ price: { id: 'price_pro_usd' } }] },
      cancel_at_period_end: false,
    });
    expect(testDb.prepare('SELECT status FROM stripe_web_checkouts').get()).toEqual({ status: 'payment_failed' });
  });

  it('does not grant access when Stripe reports a first subscription active before payment settles', async () => {
    const {
      getSubscriptionStatus,
      handleCheckoutPaymentFailed,
      handleSubscriptionUpdated,
    } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare(
      'INSERT INTO users (email, email_verified) VALUES (?, 1)',
    ).run('async-subscription@example.com').lastInsertRowid);
    const subscription = {
      id: 'sub_async',
      customer: 'cus_async',
      status: 'active',
      metadata: { userId: String(userId) },
      items: { data: [{ price: { id: 'price_max_usd' } }] },
      cancel_at_period_end: false,
    };

    handleSubscriptionUpdated(subscription);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM subscriptions').get()).toEqual({ count: 0 });
    expect(getSubscriptionStatus(userId)).toMatchObject({ isActive: false, isPro: false });

    handleSubscriptionUpdated({ ...subscription, status: 'incomplete' });
    handleSubscriptionUpdated(subscription);
    expect(testDb.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(userId)).toEqual({
      status: 'incomplete',
    });

    handleCheckoutPaymentFailed({
      id: 'sess_async',
      mode: 'subscription',
      payment_status: 'unpaid',
      subscription: 'sub_async',
      customer: 'cus_async',
    });
    expect(testDb.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(userId)).toEqual({
      status: 'incomplete_expired',
    });

    handleSubscriptionUpdated(subscription);
    handleSubscriptionUpdated({ ...subscription, status: 'incomplete' });
    expect(testDb.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(userId)).toEqual({
      status: 'incomplete_expired',
    });
    expect(getSubscriptionStatus(userId)).toMatchObject({ isActive: false, isPro: false });
  });

  it('updates only the matching public Checkout session when an email has multiple attempts', async () => {
    const { handleCheckoutPaymentFailed } = await import('../../src/services/stripe-service');
    const email = 'repeat@example.com';
    const insert = testDb.prepare(`
      INSERT INTO stripe_web_checkouts (
        email, email_hash, plan, currency, price_id, status, stripe_checkout_session_id
      ) VALUES (?, ?, 'pro', 'usd', 'price_pro_usd', ?, ?)
    `);
    insert.run(email, hashEmail(email), 'completed', 'sess_success');
    insert.run(email, hashEmail(email), 'pending', 'sess_failed');

    handleCheckoutPaymentFailed({
      id: 'sess_failed',
      subscription: 'sub_failed',
      customer: 'cus_repeat',
      metadata: { email },
    });

    expect(testDb.prepare(`
      SELECT stripe_checkout_session_id AS sessionId, status
      FROM stripe_web_checkouts
      ORDER BY id
    `).all()).toEqual([
      { sessionId: 'sess_success', status: 'completed' },
      { sessionId: 'sess_failed', status: 'payment_failed' },
    ]);
  });

  it('restores a delinquent Stripe subscription when an invoice is paid', async () => {
    const { handleInvoicePaid } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare(
      'INSERT INTO users (email, email_verified) VALUES (?, 1)',
    ).run('recovered@example.com').lastInsertRowid);
    testDb.prepare(`
      INSERT INTO subscriptions (
        user_id, plan, period, status, provider, provider_subscription_id, provider_customer_id
      ) VALUES (?, 'pro', 'monthly', 'past_due', 'stripe', 'sub_recovered', 'cus_recovered')
    `).run(userId);

    handleInvoicePaid({
      id: 'in_recovered',
      customer: 'cus_recovered',
      parent: { subscription_details: { subscription: 'sub_recovered' } },
    });

    expect(testDb.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(userId)).toEqual({
      status: 'active',
    });
  });

  it('does not restore a subscription from a paid one-time invoice for the same customer', async () => {
    const { handleInvoicePaid } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare(
      'INSERT INTO users (email, email_verified) VALUES (?, 1)',
    ).run('one-time@example.com').lastInsertRowid);
    testDb.prepare(`
      INSERT INTO subscriptions (
        user_id, plan, period, status, provider, provider_subscription_id, provider_customer_id
      ) VALUES (?, 'pro', 'monthly', 'past_due', 'stripe', 'sub_delinquent', 'cus_shared')
    `).run(userId);

    handleInvoicePaid({ id: 'in_one_time', customer: 'cus_shared', parent: null });

    expect(testDb.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(userId)).toEqual({
      status: 'past_due',
    });
  });

  it('does not auto-attach a public checkout to an existing user by email alone', async () => {
    const { handleCheckoutCompleted } = await import('../../src/services/stripe-service');
    testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('victim@example.com');
    testDb.prepare(`
      INSERT INTO stripe_web_checkouts (
        email, email_hash, plan, currency, price_id, status, stripe_checkout_session_id
      ) VALUES (?, ?, 'max', 'usd', 'price_max_usd', 'created', ?)
    `).run('victim@example.com', hashEmail('victim@example.com'), 'sess_public');

    handleCheckoutCompleted({
      id: 'sess_public',
      payment_status: 'paid',
      subscription: 'sub_public',
      customer: 'cus_public',
      metadata: { email: 'victim@example.com', plan: 'max', source: 'website' },
    });

    const subCount = (testDb.prepare('SELECT COUNT(*) AS count FROM subscriptions').get() as any).count;
    const checkout = testDb.prepare('SELECT status, user_id, stripe_subscription_id FROM stripe_web_checkouts').get() as any;
    expect(subCount).toBe(0);
    expect(checkout).toMatchObject({
      status: 'completed',
      user_id: null,
      stripe_subscription_id: 'sub_public',
    });
  });

  it('claims a website checkout only after the matching Nexus email is verified', async () => {
    const { claimWebsiteStripeSubscriptionForUser } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 0)').run('buyer@example.com').lastInsertRowid);
    testDb.prepare(`
      INSERT INTO stripe_web_checkouts (
        email, email_hash, plan, currency, price_id, status, stripe_customer_id, stripe_subscription_id
      ) VALUES (?, ?, 'max', 'brl', 'price_max_brl', 'completed', 'cus_buyer', 'sub_buyer')
    `).run('buyer@example.com', hashEmail('buyer@example.com'));
    testDb.prepare(`UPDATE stripe_web_checkouts
      SET created_at = datetime(?, '-1 minute')`).run(hoisted.claimWindow.startedAt);

    expect(claimWebsiteStripeSubscriptionForUser(userId)).toBe(false);
    expect((testDb.prepare('SELECT COUNT(*) AS count FROM subscriptions').get() as any).count).toBe(0);

    testDb.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId);
    expect(claimWebsiteStripeSubscriptionForUser(userId)).toBe(true);

    const sub = testDb.prepare('SELECT plan, provider, provider_subscription_id FROM subscriptions WHERE user_id = ?').get(userId) as any;
    const checkout = testDb.prepare('SELECT user_id FROM stripe_web_checkouts WHERE stripe_subscription_id = ?').get('sub_buyer') as any;
    expect(sub).toMatchObject({ plan: 'max', provider: 'stripe', provider_subscription_id: 'sub_buyer' });
    expect(checkout.user_id).toBe(userId);

    testDb.prepare(`UPDATE subscriptions SET status = 'past_due' WHERE user_id = ?`).run(userId);
    expect(claimWebsiteStripeSubscriptionForUser(userId)).toBe(false);
    expect(testDb.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(userId))
      .toEqual({ status: 'past_due' });
  });

  it('rechecks anonymous checkout eligibility inside the immediate ownership transaction', async () => {
    const { claimWebsiteStripeSubscriptionForUser } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare(
      'INSERT INTO users (email, email_verified) VALUES (?, 1)',
    ).run('raced@example.com').lastInsertRowid);
    testDb.prepare(`INSERT INTO stripe_web_checkouts (
      email, email_hash, plan, currency, price_id, status,
      stripe_customer_id, stripe_subscription_id, created_at
    ) VALUES (?, ?, 'max', 'usd', 'price_max_usd', 'completed',
      'cus_raced', 'sub_raced', datetime(?, '-1 minute'))`)
      .run('raced@example.com', hashEmail('raced@example.com'), hoisted.claimWindow.startedAt);

    const backingDb = testDb;
    const beginTransaction = backingDb.transaction.bind(backingDb);
    testDb = new Proxy(backingDb, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (callback: (...args: unknown[]) => unknown) => {
            const transaction = beginTransaction(callback);
            const runImmediate = transaction.immediate.bind(transaction);
            return Object.assign(
              (...args: unknown[]) => transaction(...args),
              {
                immediate: (...args: unknown[]) => {
                  backingDb.prepare(`UPDATE stripe_web_checkouts
                    SET status = 'failed', updated_at = datetime('now')
                    WHERE stripe_subscription_id = 'sub_raced'`).run();
                  return runImmediate(...args);
                },
              },
            );
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Database.Database;

    expect(claimWebsiteStripeSubscriptionForUser(userId)).toBe(false);
    expect(backingDb.prepare(
      'SELECT status, user_id FROM stripe_web_checkouts WHERE stripe_subscription_id = ?',
    ).get('sub_raced')).toEqual({ status: 'failed', user_id: null });
    expect((backingDb.prepare('SELECT COUNT(*) AS count FROM subscriptions').get() as any).count)
      .toBe(0);
  });

  it('refuses anonymous checkout claims outside the exact 30-day compatibility window', async () => {
    const { claimWebsiteStripeSubscriptionForUser } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare(
      'INSERT INTO users (email, email_verified) VALUES (?, 1)',
    ).run('sunset@example.com').lastInsertRowid);
    testDb.prepare(`INSERT INTO stripe_web_checkouts (
      email, email_hash, plan, currency, price_id, status,
      stripe_customer_id, stripe_subscription_id, created_at
    ) VALUES (?, ?, 'pro', 'usd', 'price_pro_usd', 'completed',
      'cus_sunset', 'sub_sunset', datetime(?, '-1 minute'))`)
      .run('sunset@example.com', hashEmail('sunset@example.com'), hoisted.claimWindow.startedAt);

    hoisted.claimWindow.sunsetAt = new Date(Date.now() - 1).toISOString();
    hoisted.claimWindow.startedAt = new Date(
      Date.parse(hoisted.claimWindow.sunsetAt) - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(claimWebsiteStripeSubscriptionForUser(userId)).toBe(false);
    expect((testDb.prepare('SELECT COUNT(*) AS count FROM subscriptions').get() as any).count)
      .toBe(0);
  });

  it('does not revive an unclaimed checkout after Stripe deletes its subscription', async () => {
    const {
      claimWebsiteStripeSubscriptionForUser,
      handleCheckoutCompleted,
      handleInvoicePaid,
      handleSubscriptionDeleted,
    } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare(
      'INSERT INTO users (email, email_verified) VALUES (?, 1)',
    ).run('deleted-before-claim@example.com').lastInsertRowid);
    testDb.prepare(`INSERT INTO stripe_web_checkouts (
      email, email_hash, plan, currency, price_id, status,
      stripe_customer_id, stripe_subscription_id, stripe_checkout_session_id, created_at
    ) VALUES (?, ?, 'pro', 'usd', 'price_pro_usd', 'completed',
      'cus_deleted_before_claim', 'sub_deleted_before_claim', 'sess_deleted_before_claim',
      datetime(?, '-1 minute'))`)
      .run(
        'deleted-before-claim@example.com',
        hashEmail('deleted-before-claim@example.com'),
        hoisted.claimWindow.startedAt,
      );

    handleSubscriptionDeleted({
      id: 'sub_deleted_before_claim',
      customer: 'cus_deleted_before_claim',
      metadata: {},
    });

    expect(testDb.prepare(`SELECT status, user_id FROM stripe_web_checkouts
      WHERE stripe_subscription_id = ?`).get('sub_deleted_before_claim'))
      .toEqual({ status: 'canceled', user_id: null });

    handleCheckoutCompleted({
      id: 'sess_deleted_before_claim',
      mode: 'subscription',
      payment_status: 'paid',
      subscription: 'sub_deleted_before_claim',
      customer: 'cus_deleted_before_claim',
      metadata: {
        email: 'deleted-before-claim@example.com',
        plan: 'pro',
        currency: 'usd',
      },
    });

    expect(testDb.prepare(`SELECT status, user_id FROM stripe_web_checkouts
      WHERE stripe_subscription_id = ?`).get('sub_deleted_before_claim'))
      .toEqual({ status: 'canceled', user_id: null });

    handleInvoicePaid({
      id: 'in_stale_after_delete',
      customer: 'cus_deleted_before_claim',
      parent: { subscription_details: { subscription: 'sub_deleted_before_claim' } },
    });

    expect(testDb.prepare(`SELECT status, user_id FROM stripe_web_checkouts
      WHERE stripe_subscription_id = ?`).get('sub_deleted_before_claim'))
      .toEqual({ status: 'canceled', user_id: null });
    expect(claimWebsiteStripeSubscriptionForUser(userId)).toBe(false);
    expect((testDb.prepare('SELECT COUNT(*) AS count FROM subscriptions').get() as any).count)
      .toBe(0);
  });

  it('rejects an Apple original transaction id claimed by another active account', async () => {
    const {
      handleAppleTransaction,
      isAppleTransactionAlreadyClaimedError,
    } = await import('../../src/services/stripe-service');
    const userOne = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('apple-one@example.com').lastInsertRowid);
    const userTwo = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('apple-two@example.com').lastInsertRowid);

    handleAppleTransaction(userOne, '2000000123456789', 'me.nexushub.pro.monthly', new Date(Date.now() + 86400000).toISOString(), null, appleGrantContext(userOne));

    expect(() => handleAppleTransaction(
        userTwo,
        '2000000123456789',
        'me.nexushub.max.monthly',
        new Date(Date.now() + 86400000).toISOString(),
        null,
        appleGrantContext(userTwo),
      ))
      .toThrowError(expect.objectContaining({ name: 'AppleTransactionAlreadyClaimedError' }));

    try {
      handleAppleTransaction(
        userTwo,
        '2000000123456789',
        'me.nexushub.max.monthly',
        new Date(Date.now() + 86400000).toISOString(),
        null,
        appleGrantContext(userTwo),
      );
    } catch (err) {
      expect(isAppleTransactionAlreadyClaimedError(err)).toBe(true);
    }
    expect(testDb.prepare('SELECT plan, status, provider FROM subscriptions WHERE user_id = ?').get(userOne)).toMatchObject({
      plan: 'pro',
      status: 'active',
      provider: 'apple',
    });
    expect(testDb.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userTwo)).toBeUndefined();
  });

  it('rejects an Apple grant when authenticated tenant and user scopes disagree', async () => {
    const {
      handleAppleTransaction,
      isAppleTransactionAccountMismatchError,
    } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare(
      'INSERT INTO users (email, email_verified) VALUES (?, 1)',
    ).run('apple-tenant-mismatch@example.com').lastInsertRowid);
    const context = { ...appleGrantContext(userId), tenantId: userId + 1 };

    try {
      handleAppleTransaction(
        userId,
        '2000000123456798',
        'me.nexushub.pro.monthly',
        new Date(Date.now() + 86400000).toISOString(),
        null,
        context,
      );
      throw new Error('expected Apple tenant mismatch refusal');
    } catch (error) {
      expect(isAppleTransactionAccountMismatchError(error)).toBe(true);
    }
    expect(testDb.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId)).toBeUndefined();
  });

  it('recovers an Apple original transaction id from a terminal prior account', async () => {
    const { handleAppleTransaction } = await import('../../src/services/stripe-service');
    const userOne = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('apple-stale@example.com').lastInsertRowid);
    const userTwo = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('apple-restore@example.com').lastInsertRowid);
    const originalTransactionId = '2000000123456790';

    handleAppleTransaction(
      userOne,
      originalTransactionId,
      'me.nexushub.pro.monthly',
      new Date(Date.now() + 86400000).toISOString(),
      null,
      appleGrantContext(userOne),
    );
    testDb.prepare(`
      UPDATE subscriptions
         SET status = 'expired',
             current_period_end = ?
       WHERE user_id = ?
    `).run(new Date(Date.now() - 86400000).toISOString(), userOne);

    const result = handleAppleTransaction(
      userTwo,
      originalTransactionId,
      'me.nexushub.max.monthly',
      new Date(Date.now() + 86400000).toISOString(),
      null,
      appleGrantContext(userTwo),
    );

    expect(result).toMatchObject({ plan: 'max', period: 'monthly', transferredFromUserId: userOne });
    expect(testDb.prepare('SELECT plan, status, provider FROM subscriptions WHERE user_id = ?').get(userTwo)).toMatchObject({
      plan: 'max',
      status: 'active',
      provider: 'apple',
    });
    expect(testDb.prepare('SELECT status, provider_subscription_id FROM subscriptions WHERE user_id = ?').get(userOne)).toMatchObject({
      status: 'inactive',
      provider_subscription_id: null,
    });
  });

  it('persists the Apple environment claim as provenance on the grant', async () => {
    const { handleAppleTransaction } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('apple-sandbox@example.com').lastInsertRowid);

    vi.stubEnv('APPLE_ALLOW_SANDBOX_GRANTS', 'true');
    vi.stubEnv('APPLE_APP_REVIEW_SANDBOX_USER_ID', String(userId));
    const context = appleGrantContext(userId, 'Sandbox');
    handleAppleTransaction(
      userId,
      '2000000123456799',
      'me.nexushub.pro.monthly',
      new Date(Date.now() + 86400000).toISOString(),
      null,
      context,
    );

    expect(testDb.prepare('SELECT status, environment, provider_customer_id FROM subscriptions WHERE user_id = ?').get(userId)).toMatchObject({
      status: 'active',
      environment: 'Sandbox',
      provider_customer_id: context.appAccountToken,
    });
  });

  it('refuses to grant a plan for an unmapped Apple product id', async () => {
    const {
      handleAppleTransaction,
      UnknownAppleProductError,
      resolveAppleProduct,
    } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('apple-unknown@example.com').lastInsertRowid);

    // Substring matching used to default every unrecognised id to Pro monthly.
    expect(resolveAppleProduct('me.nexushub.pro.weekly')).toBeNull();
    expect(resolveAppleProduct('com.attacker.max.yearly')).toBeNull();
    expect(resolveAppleProduct('me.nexushub.max.yearly')).toEqual({ plan: 'max', period: 'yearly' });

    expect(() => handleAppleTransaction(
      userId,
      '2000000123456800',
      'me.nexushub.pro.weekly',
      new Date(Date.now() + 86400000).toISOString(),
    )).toThrow(UnknownAppleProductError);
    expect((testDb.prepare('SELECT COUNT(*) AS count FROM subscriptions').get() as any).count).toBe(0);
  });

  it('round-trips a user id through the derived appAccountToken and rejects forgeries', async () => {
    const {
      deriveAppleAppAccountToken,
      resolveUserIdFromAppleAppAccountToken,
    } = await import('../../src/services/stripe-service');

    const token = deriveAppleAppAccountToken(4242);
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(resolveUserIdFromAppleAppAccountToken(token)).toBe(4242);
    expect(deriveAppleAppAccountToken(4242)).toBe(token);

    // Flipping the embedded user id invalidates the HMAC tag.
    const forged = `01001091-${token!.slice(9)}`;
    expect(resolveUserIdFromAppleAppAccountToken(forged)).toBeNull();
    expect(resolveUserIdFromAppleAppAccountToken('not-a-uuid')).toBeNull();
    expect(resolveUserIdFromAppleAppAccountToken(null)).toBeNull();
    expect(deriveAppleAppAccountToken(0)).toBeNull();
  });

  it('derives a date-safe Apple monthly period start at month end', async () => {
    const { handleAppleTransaction } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare(
      'INSERT INTO users (email, email_verified) VALUES (?, 1)',
    ).run('apple-month-end@example.com').lastInsertRowid);

    handleAppleTransaction(
      userId,
      '2000000123456790',
      'me.nexushub.pro.monthly',
      '2028-03-31T12:34:56.000Z',
      null,
      appleGrantContext(userId),
    );

    expect(testDb.prepare(
      'SELECT current_period_start, current_period_end FROM subscriptions WHERE user_id = ?',
    ).get(userId)).toMatchObject({
      current_period_start: '2028-02-29T12:34:56.000Z',
      current_period_end: '2028-03-31T12:34:56.000Z',
    });
  });

  it('skips subscription updates with unknown Stripe price IDs', async () => {
    const { handleSubscriptionUpdated } = await import('../../src/services/stripe-service');
    testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('known@example.com');

    handleSubscriptionUpdated({
      id: 'sub_unknown',
      customer: 'cus_unknown',
      status: 'active',
      metadata: { userId: '1' },
      items: {
        data: [{
          price: { id: 'price_unknown' },
          current_period_start: 1_700_000_000,
          current_period_end: 1_700_086_400,
        }],
      },
      cancel_at_period_end: false,
    });

    expect((testDb.prepare('SELECT COUNT(*) AS count FROM subscriptions').get() as any).count).toBe(0);
    expect(JSON.stringify(hoisted.loggerWarn.mock.calls)).toContain('unknown price id');
  });

  it.each([
    ['price_1U55BS3kbWVFdS6025onefOr', 'pro'],
    ['price_1U55Cl3kbWVFdS60VAeMzEyf', 'max'],
    ['price_historical_pro_operator', 'pro'],
    ['price_historical_max_operator', 'max'],
  ])('retains historical monthly price %s for webhook entitlement reconciliation', async (priceId, plan) => {
    const { handleSubscriptionUpdated } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare(
      'INSERT INTO users (email, email_verified) VALUES (?, 1)',
    ).run(`${plan}-historical@example.com`).lastInsertRowid);
    testDb.prepare(`
      INSERT INTO subscriptions (
        user_id, plan, period, status, provider, provider_subscription_id
      ) VALUES (?, 'free', 'monthly', 'active', 'stripe', ?)
    `).run(userId, `sub_historical_${plan}`);

    handleSubscriptionUpdated({
      id: `sub_historical_${plan}`,
      customer: `cus_historical_${plan}`,
      status: 'active',
      metadata: { userId: String(userId) },
      items: {
        data: [{
          price: { id: priceId },
          current_period_start: 1_700_000_000,
          current_period_end: 1_700_086_400,
        }],
      },
      cancel_at_period_end: false,
    });

    expect(testDb.prepare(
      'SELECT plan, period, provider FROM subscriptions WHERE user_id = ?',
    ).get(userId)).toMatchObject({ plan, period: 'monthly', provider: 'stripe' });
    expect(JSON.stringify(hoisted.loggerWarn.mock.calls)).not.toContain('unknown price id');
  });

  it('applies subscription updates after a website checkout has been explicitly claimed', async () => {
    const { handleSubscriptionUpdated } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('claimed@example.com').lastInsertRowid);
    testDb.prepare(`
      INSERT INTO stripe_web_checkouts (
        email, email_hash, plan, currency, price_id, status,
        stripe_customer_id, stripe_subscription_id, user_id
      ) VALUES (?, ?, 'max', 'brl', 'price_max_brl', 'completed', 'cus_claimed', 'sub_claimed', ?)
    `).run('claimed@example.com', hashEmail('claimed@example.com'), userId);

    handleSubscriptionUpdated({
      id: 'sub_claimed',
      customer: 'cus_claimed',
      status: 'active',
      metadata: { source: 'website' },
      items: {
        data: [{
          price: { id: 'price_max_brl' },
          current_period_start: 1_700_000_000,
          current_period_end: 1_700_086_400,
        }],
      },
      cancel_at_period_end: false,
    });

    const sub = testDb.prepare('SELECT plan, period, status, provider FROM subscriptions WHERE user_id = ?').get(userId) as any;
    expect(sub).toEqual({ plan: 'max', period: 'monthly', status: 'active', provider: 'stripe' });
  });

  it('records Basil/Dahlia subscription periods from the first subscription item', async () => {
    const {
      getSubscriptionStatus,
      handleCheckoutCompleted,
      handleSubscriptionUpdated,
    } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('period@example.com').lastInsertRowid);
    const futurePeriodEnd = Math.floor((Date.now() + 7 * 86400000) / 1000);

    handleCheckoutCompleted({
      id: 'sess_period',
      payment_status: 'paid',
      subscription: 'sub_period',
      customer: 'cus_period',
      metadata: { userId: String(userId), plan: 'max', currency: 'usd' },
    });

    handleSubscriptionUpdated({
      id: 'sub_period',
      customer: 'cus_period',
      status: 'active',
      metadata: { userId: String(userId) },
      items: {
        data: [{
          price: { id: 'price_max_usd' },
          current_period_start: 1_700_000_000,
          current_period_end: futurePeriodEnd,
        }],
      },
      cancel_at_period_end: false,
    });

    const sub = testDb.prepare('SELECT current_period_start, current_period_end FROM subscriptions WHERE user_id = ?').get(userId) as any;
    expect(sub.current_period_start).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(sub.current_period_end).toBe(new Date(futurePeriodEnd * 1000).toISOString());
    expect(getSubscriptionStatus(userId)).toMatchObject({ plan: 'max', isActive: true, isPro: true });

    testDb.prepare('UPDATE subscriptions SET current_period_end = ? WHERE user_id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), userId);
    expect(getSubscriptionStatus(userId)).toMatchObject({ plan: 'free', status: 'expired', isActive: false });
  });

  it('normalizes legacy SQLite-space billing timestamps in public status', async () => {
    const { getSubscriptionStatus } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('legacy-time@example.com').lastInsertRowid);
    const futureIso = new Date(Date.now() + 7 * 86400000).toISOString();
    const sqliteFuture = futureIso.slice(0, 19).replace('T', ' ');
    testDb.prepare(`
      INSERT INTO subscriptions (
        user_id, plan, period, status, provider, current_period_end
      ) VALUES (?, 'pro', 'monthly', 'active', 'stripe', ?)
    `).run(userId, sqliteFuture);

    expect(getSubscriptionStatus(userId).currentPeriodEnd).toBe(
      new Date(`${sqliteFuture.replace(' ', 'T')}Z`).toISOString(),
    );
  });

  it('revokes stale users.tier and sends cancellation email when Stripe subscription is deleted', async () => {
    const { handleSubscriptionDeleted } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('cancel@example.com').lastInsertRowid);
    testDb.prepare(`
      INSERT INTO subscriptions (
        user_id, plan, period, status, provider, provider_subscription_id, provider_customer_id
      ) VALUES (?, 'max', 'monthly', 'active', 'stripe', 'sub_cancel', 'cus_cancel')
    `).run(userId);
    testDb.prepare("UPDATE users SET tier = 'max' WHERE id = ?").run(userId);

    handleSubscriptionDeleted({ id: 'sub_cancel', customer: 'cus_cancel', metadata: {} });

    const sub = testDb.prepare('SELECT status, cancel_at_period_end FROM subscriptions WHERE user_id = ?').get(userId) as any;
    const user = testDb.prepare('SELECT tier FROM users WHERE id = ?').get(userId) as any;
    expect(sub).toMatchObject({ status: 'canceled', cancel_at_period_end: 1 });
    expect(user.tier).toBe('free');
    expect(hoisted.sendCancellationConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      to: 'cancel@example.com',
      plan: 'max',
    }));
  });

  it('marks invoice failures past_due and queues a dunning email', async () => {
    const { handleInvoicePaymentFailed } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('pastdue@example.com').lastInsertRowid);
    testDb.prepare(`
      INSERT INTO subscriptions (
        user_id, plan, period, status, provider, provider_subscription_id, provider_customer_id
      ) VALUES (?, 'pro', 'monthly', 'active', 'stripe', 'sub_failed', 'cus_failed')
    `).run(userId);

    handleInvoicePaymentFailed({
      id: 'in_failed',
      customer: 'cus_failed',
      parent: { subscription_details: { subscription: { id: 'sub_failed' } } },
      hosted_invoice_url: 'https://billing.stripe.test/invoices/in_failed',
    });

    const sub = testDb.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(userId) as any;
    expect(sub.status).toBe('past_due');
    expect(hoisted.sendPaymentFailed).toHaveBeenCalledWith(expect.objectContaining({
      to: 'pastdue@example.com',
      invoiceId: 'in_failed',
      hostedInvoiceUrl: 'https://billing.stripe.test/invoices/in_failed',
      plan: 'pro',
    }));
  });

  it('records Stripe webhook event IDs durably for idempotency', async () => {
    const {
      hasProcessedStripeWebhookEvent,
      markStripeWebhookEventProcessed,
    } = await import('../../src/services/stripe-service');

    expect(hasProcessedStripeWebhookEvent('evt_123')).toBe(false);
    markStripeWebhookEventProcessed('evt_123', 'checkout.session.completed');
    expect(hasProcessedStripeWebhookEvent('evt_123')).toBe(true);
    markStripeWebhookEventProcessed('evt_123', 'checkout.session.completed');
    expect((testDb.prepare('SELECT COUNT(*) AS count FROM stripe_webhook_events').get() as any).count).toBe(1);
  });

  it('de-duplicates replayed Apple notificationUUIDs', async () => {
    const { handleAppleNotification, handleAppleTransaction } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('apple-replay@example.com').lastInsertRowid);
    handleAppleTransaction(userId, '2000000123456801', 'me.nexushub.pro.monthly', new Date(Date.now() + 86400000).toISOString(), null, appleGrantContext(userId));

    const context = { notificationUUID: 'c0ffee00-1111-2222-3333-444444444444', environment: 'Sandbox' };
    expect(handleAppleNotification('EXPIRED', appleTransactionJws({
      originalTransactionId: '2000000123456801',
      productId: 'me.nexushub.pro.monthly',
    }), context)).toBe(true);
    expect(testDb.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(userId)).toMatchObject({ status: 'expired' });

    // Apple retries until it gets a 200, so the same UUID arrives again.
    testDb.prepare("UPDATE subscriptions SET status = 'active' WHERE user_id = ?").run(userId);
    expect(handleAppleNotification('EXPIRED', appleTransactionJws({
      originalTransactionId: '2000000123456801',
      productId: 'me.nexushub.pro.monthly',
    }), context)).toBe(false);
    expect(testDb.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(userId)).toMatchObject({ status: 'active' });
    expect((testDb.prepare('SELECT COUNT(*) AS count FROM apple_webhook_events').get() as any).count).toBe(1);
  });

  it('applies DID_CHANGE_RENEWAL_STATUS without changing subscription status', async () => {
    const { handleAppleNotification, handleAppleTransaction } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('apple-renewal@example.com').lastInsertRowid);
    handleAppleTransaction(userId, '2000000123456802', 'me.nexushub.pro.monthly', new Date(Date.now() + 86400000).toISOString(), null, appleGrantContext(userId));

    const jws = appleTransactionJws({
      originalTransactionId: '2000000123456802',
      productId: 'me.nexushub.pro.monthly',
      environment: 'Production',
    });

    expect(handleAppleNotification('DID_CHANGE_RENEWAL_STATUS', jws, {
      notificationUUID: 'aaaa0001-0000-0000-0000-000000000000',
      subtype: 'AUTO_RENEW_DISABLED',
    })).toBe(true);
    expect(testDb.prepare('SELECT status, cancel_at_period_end, environment FROM subscriptions WHERE user_id = ?').get(userId)).toMatchObject({
      status: 'active',
      cancel_at_period_end: 1,
      environment: 'Production',
    });

    expect(handleAppleNotification('DID_CHANGE_RENEWAL_STATUS', jws, {
      notificationUUID: 'aaaa0002-0000-0000-0000-000000000000',
      subtype: 'AUTO_RENEW_ENABLED',
    })).toBe(true);
    expect(testDb.prepare('SELECT status, cancel_at_period_end FROM subscriptions WHERE user_id = ?').get(userId)).toMatchObject({
      status: 'active',
      cancel_at_period_end: 0,
    });

    expect(handleAppleNotification('DID_CHANGE_RENEWAL_STATUS', jws, {
      notificationUUID: 'aaaa0003-0000-0000-0000-000000000000',
      subtype: 'SOMETHING_ELSE',
    })).toBe(false);
  });

  it('recovers a subscription from a notification when apple-verify never landed', async () => {
    const { handleAppleNotification, deriveAppleAppAccountToken } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('apple-recover@example.com').lastInsertRowid);
    const expiresDate = Date.now() + 30 * 86400000;

    expect(handleAppleNotification('SUBSCRIBED', appleTransactionJws({
      originalTransactionId: '2000000123456803',
      productId: 'me.nexushub.max.yearly',
      appAccountToken: deriveAppleAppAccountToken(userId),
      environment: 'Production',
      expiresDate,
    }), { notificationUUID: 'bbbb0001-0000-0000-0000-000000000000' })).toBe(true);

    expect(testDb.prepare('SELECT plan, period, status, provider, provider_subscription_id, environment FROM subscriptions WHERE user_id = ?').get(userId)).toMatchObject({
      plan: 'max',
      period: 'yearly',
      status: 'active',
      provider: 'apple',
      provider_subscription_id: '2000000123456803',
      environment: 'Production',
    });
  });

  it('refuses to invent a subscription row from an unmappable notification', async () => {
    const { handleAppleNotification, deriveAppleAppAccountToken } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('apple-noinvent@example.com').lastInsertRowid);
    const appAccountToken = deriveAppleAppAccountToken(userId);

    // No appAccountToken: nothing identifies the owner.
    expect(handleAppleNotification('SUBSCRIBED', appleTransactionJws({
      originalTransactionId: '2000000123456804',
      productId: 'me.nexushub.pro.monthly',
    }), { notificationUUID: 'cccc0001-0000-0000-0000-000000000000' })).toBe(false);

    // Terminal events never create a row.
    expect(handleAppleNotification('REFUND', appleTransactionJws({
      originalTransactionId: '2000000123456805',
      productId: 'me.nexushub.pro.monthly',
      appAccountToken,
    }), { notificationUUID: 'cccc0002-0000-0000-0000-000000000000' })).toBe(false);

    // An unmapped product id must not silently become Pro.
    expect(handleAppleNotification('SUBSCRIBED', appleTransactionJws({
      originalTransactionId: '2000000123456806',
      productId: 'me.nexushub.pro.weekly',
      appAccountToken,
      environment: 'Production',
      expiresDate: Date.now() + 30 * 86400000,
    }), { notificationUUID: 'cccc0003-0000-0000-0000-000000000000' })).toBe(false);

    expect((testDb.prepare('SELECT COUNT(*) AS count FROM subscriptions').get() as any).count).toBe(0);
  });

  it('never overwrites an active Stripe subscription from an Apple notification', async () => {
    const { handleAppleNotification, deriveAppleAppAccountToken } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('apple-vs-stripe@example.com').lastInsertRowid);
    testDb.prepare(`
      INSERT INTO subscriptions (
        user_id, plan, period, status, provider, provider_subscription_id
      ) VALUES (?, 'max', 'monthly', 'active', 'stripe', 'sub_live')
    `).run(userId);

    expect(handleAppleNotification('SUBSCRIBED', appleTransactionJws({
      originalTransactionId: '2000000123456807',
      productId: 'me.nexushub.pro.monthly',
      appAccountToken: deriveAppleAppAccountToken(userId),
      environment: 'Production',
      expiresDate: Date.now() + 30 * 86400000,
    }), { notificationUUID: 'dddd0001-0000-0000-0000-000000000000' })).toBe(false);

    expect(testDb.prepare('SELECT plan, provider, provider_subscription_id FROM subscriptions WHERE user_id = ?').get(userId)).toMatchObject({
      plan: 'max',
      provider: 'stripe',
      provider_subscription_id: 'sub_live',
    });
  });

  it('reports expired active or trialing rows as inactive for billing status', async () => {
    const { getSubscriptionStatus } = await import('../../src/services/stripe-service');
    testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('expired@example.com');
    testDb.prepare(`
      INSERT INTO subscriptions (
        user_id, plan, period, status, provider, current_period_end
      ) VALUES (1, 'max', 'monthly', 'trialing', 'beta', ?)
    `).run(new Date(Date.now() - 60_000).toISOString());

    expect(getSubscriptionStatus(1)).toMatchObject({
      plan: 'free',
      status: 'expired',
      provider: 'beta',
      isActive: false,
      isPro: false,
    });
  });
});
