import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { hashEmail } from '../../src/utils/identity';

let testDb: Database.Database;

const hoisted = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  sendPaymentReceipt: vi.fn(),
  sendPaymentFailed: vi.fn(),
  sendCancellationConfirmation: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: {
      secretKey: 'sk_test',
      webhookSecret: 'whsec_test',
      priceProMonthly: 'price_pro_usd',
      priceProYearly: '',
      priceMaxMonthly: 'price_max_usd',
      priceMaxYearly: '',
      priceProMonthlyBrl: 'price_pro_brl',
      priceProYearlyBrl: '',
      priceMaxMonthlyBrl: 'price_max_brl',
      priceMaxYearlyBrl: '',
    },
    ios: {
      jwtSecret: 'test-ios-jwt-secret-at-least-32-bytes-long',
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
    error: vi.fn(),
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
    testDb = new Database(':memory:');
    createSchema(testDb);
    hoisted.loggerWarn.mockReset();
    hoisted.loggerInfo.mockReset();
    hoisted.sendPaymentReceipt.mockReset();
    hoisted.sendPaymentReceipt.mockResolvedValue(true);
    hoisted.sendPaymentFailed.mockReset();
    hoisted.sendPaymentFailed.mockResolvedValue(true);
    hoisted.sendCancellationConfirmation.mockReset();
    hoisted.sendCancellationConfirmation.mockResolvedValue(true);
  });

  afterEach(() => {
    testDb.close();
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

    expect(claimWebsiteStripeSubscriptionForUser(userId)).toBe(false);
    expect((testDb.prepare('SELECT COUNT(*) AS count FROM subscriptions').get() as any).count).toBe(0);

    testDb.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId);
    expect(claimWebsiteStripeSubscriptionForUser(userId)).toBe(true);

    const sub = testDb.prepare('SELECT plan, provider, provider_subscription_id FROM subscriptions WHERE user_id = ?').get(userId) as any;
    const checkout = testDb.prepare('SELECT user_id FROM stripe_web_checkouts WHERE stripe_subscription_id = ?').get('sub_buyer') as any;
    expect(sub).toMatchObject({ plan: 'max', provider: 'stripe', provider_subscription_id: 'sub_buyer' });
    expect(checkout.user_id).toBe(userId);
  });

  it('rejects an Apple original transaction id claimed by another active account', async () => {
    const {
      handleAppleTransaction,
      isAppleTransactionAlreadyClaimedError,
    } = await import('../../src/services/stripe-service');
    const userOne = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('apple-one@example.com').lastInsertRowid);
    const userTwo = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('apple-two@example.com').lastInsertRowid);

    handleAppleTransaction(userOne, '2000000123456789', 'me.nexushub.pro.monthly', new Date(Date.now() + 86400000).toISOString());

    expect(() => handleAppleTransaction(
        userTwo,
        '2000000123456789',
        'me.nexushub.max.monthly',
        new Date(Date.now() + 86400000).toISOString(),
      ))
      .toThrowError(expect.objectContaining({ name: 'AppleTransactionAlreadyClaimedError' }));

    try {
      handleAppleTransaction(
        userTwo,
        '2000000123456789',
        'me.nexushub.max.monthly',
        new Date(Date.now() + 86400000).toISOString(),
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

    handleAppleTransaction(
      userId,
      '2000000123456799',
      'me.nexushub.pro.monthly',
      new Date(Date.now() + 86400000).toISOString(),
      null,
      { environment: 'Sandbox', appAccountToken: '01000000-0000-0000-0000-000000000000' },
    );

    expect(testDb.prepare('SELECT status, environment, provider_customer_id FROM subscriptions WHERE user_id = ?').get(userId)).toMatchObject({
      status: 'active',
      environment: 'Sandbox',
      provider_customer_id: '01000000-0000-0000-0000-000000000000',
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
    const { getSubscriptionStatus, handleSubscriptionUpdated } = await import('../../src/services/stripe-service');
    const userId = Number(testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('period@example.com').lastInsertRowid);
    const futurePeriodEnd = Math.floor((Date.now() + 7 * 86400000) / 1000);

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
        user_id, plan, period, status, provider, provider_customer_id
      ) VALUES (?, 'pro', 'monthly', 'active', 'stripe', 'cus_failed')
    `).run(userId);

    handleInvoicePaymentFailed({
      id: 'in_failed',
      customer: 'cus_failed',
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
    handleAppleTransaction(userId, '2000000123456801', 'me.nexushub.pro.monthly', new Date(Date.now() + 86400000).toISOString());

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
    handleAppleTransaction(userId, '2000000123456802', 'me.nexushub.pro.monthly', new Date(Date.now() + 86400000).toISOString());

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
      environment: 'Sandbox',
      expiresDate,
    }), { notificationUUID: 'bbbb0001-0000-0000-0000-000000000000' })).toBe(true);

    expect(testDb.prepare('SELECT plan, period, status, provider, provider_subscription_id, environment FROM subscriptions WHERE user_id = ?').get(userId)).toMatchObject({
      plan: 'max',
      period: 'yearly',
      status: 'active',
      provider: 'apple',
      provider_subscription_id: '2000000123456803',
      environment: 'Sandbox',
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
