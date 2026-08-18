// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
let stripePackSalesEnabled = false;

vi.mock('../../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/database')>();
  return {
    ...actual,
    getDb: () => db,
    initDatabase: vi.fn(),
    closeDatabase: vi.fn(),
  };
});

vi.mock('../../src/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      get hybridCommerce() {
        return {
          stripePriceIds: { planProMonthly: '', planMaxMonthly: '', pack100: 'price_pack100', pack250: '', pack600: '' },
          appleProductIds: { pack100: '', pack250: '', pack600: '' },
          applePackFulfillmentEnabled: false,
          stripePackFulfillmentEnabled: stripePackSalesEnabled,
          anonymousCheckoutEnabled: true,
        };
      },
    },
  };
});

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { getAiCreditWallet } from '../../src/services/ai-credit-ledger';
import {
  fulfillStripeCreditPackCheckout,
  handleCheckoutCompleted,
  handleStripeCreditPackReversal,
} from '../../src/services/stripe-service';

const NOW = new Date('2026-08-18T12:00:00.000Z');

function packSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_1',
    mode: 'payment',
    payment_intent: 'pi_pack_1',
    metadata: { userId: '40', catalogItemId: 'pack.credits.100' },
    ...overrides,
  };
}

describe('stripe credit-pack fulfillment', () => {
  beforeEach(() => {
    db = createMigratedTestDatabase();
    stripePackSalesEnabled = false;
  });

  afterEach(() => {
    db.close();
  });

  it('grants the purchased lot from a completed payment session, independent of the sales switch', () => {
    handleCheckoutCompleted(packSession());
    const wallet = getAiCreditWallet(40, 'pro', NOW);
    expect(wallet.purchasedRemaining).toBe(100);
    const lot = db.prepare('SELECT provider, provider_transaction_id, credits_granted FROM ai_credit_lots').get();
    expect(lot).toEqual({ provider: 'stripe', provider_transaction_id: 'pi_pack_1', credits_granted: 100 });
  });

  it('dedupes duplicate and out-of-order webhook deliveries on the payment intent', () => {
    handleCheckoutCompleted(packSession());
    handleCheckoutCompleted(packSession({ id: 'cs_test_redelivery' }));
    expect(fulfillStripeCreditPackCheckout(packSession({ id: 'cs_async' }))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_lots').get()).toEqual({ count: 1 });
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(100);
  });

  it('fails closed on forged catalog items and missing owner bindings', () => {
    expect(fulfillStripeCreditPackCheckout(packSession({ metadata: { userId: '40', catalogItemId: 'pack.credits.999999' } }))).toBe(false);
    expect(fulfillStripeCreditPackCheckout(packSession({ metadata: { catalogItemId: 'pack.credits.100' } }))).toBe(false);
    expect(fulfillStripeCreditPackCheckout(packSession({ metadata: { userId: '40', catalogItemId: 'plan.pro.monthly' } }))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_lots').get()).toEqual({ count: 0 });
  });

  it('leaves subscription checkout sessions on the legacy path', () => {
    expect(() => handleCheckoutCompleted({
      id: 'cs_sub',
      mode: 'subscription',
      metadata: { userId: '40' },
    })).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_credit_lots').get()).toEqual({ count: 0 });
  });

  it('revokes only the originating lot on refund or dispute', () => {
    handleCheckoutCompleted(packSession());
    handleCheckoutCompleted(packSession({ payment_intent: 'pi_pack_keep', metadata: { userId: '40', catalogItemId: 'pack.credits.100' } }));
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(200);

    expect(handleStripeCreditPackReversal({ payment_intent: 'pi_pack_1' }, 'refund')).toBe(true);
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(100);
    expect(handleStripeCreditPackReversal({ payment_intent: 'pi_unknown' }, 'dispute')).toBe(false);
    expect(getAiCreditWallet(40, 'pro', NOW).purchasedRemaining).toBe(100);
  });
});
