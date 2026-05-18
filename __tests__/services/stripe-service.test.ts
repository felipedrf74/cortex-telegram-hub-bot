import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { hashEmail } from '../../src/utils/identity';

let testDb: Database.Database;

const hoisted = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
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
  },
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
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

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0
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
  `);
}

describe('stripe service billing reconciliation', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    createSchema(testDb);
    hoisted.loggerWarn.mockReset();
    hoisted.loggerInfo.mockReset();
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

  it('skips subscription updates with unknown Stripe price IDs', async () => {
    const { handleSubscriptionUpdated } = await import('../../src/services/stripe-service');
    testDb.prepare('INSERT INTO users (email, email_verified) VALUES (?, 1)').run('known@example.com');

    handleSubscriptionUpdated({
      id: 'sub_unknown',
      customer: 'cus_unknown',
      status: 'active',
      metadata: { userId: '1' },
      items: { data: [{ price: { id: 'price_unknown' } }] },
      current_period_start: 1_700_000_000,
      current_period_end: 1_700_086_400,
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
      items: { data: [{ price: { id: 'price_max_brl' } }] },
      current_period_start: 1_700_000_000,
      current_period_end: 1_700_086_400,
      cancel_at_period_end: false,
    });

    const sub = testDb.prepare('SELECT plan, period, status, provider FROM subscriptions WHERE user_id = ?').get(userId) as any;
    expect(sub).toEqual({ plan: 'max', period: 'monthly', status: 'active', provider: 'stripe' });
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
