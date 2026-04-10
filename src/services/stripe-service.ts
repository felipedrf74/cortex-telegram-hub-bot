// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Stripe Billing Service
 *
 * Manages web-based subscriptions via Stripe Checkout + Customer Portal.
 * Writes to the `subscriptions` SQLite table (single source of truth shared
 * with Apple IAP). The iOS app reads status via GET /api/v1/billing/status.
 *
 * Token-zero: no AI pipeline involved. Pure REST CRUD on the subscriptions
 * table, orchestrated by Stripe webhook events.
 */

import StripeLib from 'stripe';
import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';

// Stripe v17+ uses a different export shape. The namespace for types
// is accessed via the default export's type definitions.
type StripeInstance = InstanceType<typeof StripeLib>;

// ── Types ───────────────────────────────────────────────────────────

export interface SubscriptionStatus {
  plan: string;
  period: string;
  status: string;
  provider: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  isActive: boolean;
  isPro: boolean;
}

// Price ID → plan mapping. The env vars hold Stripe price_xxx IDs;
// this map resolves them to our internal plan names on checkout.
function resolvePlan(priceId: string): { plan: string; period: string } {
  const { stripe: s } = config;
  // USD prices
  if (priceId === s.priceProMonthly) return { plan: 'pro', period: 'monthly' };
  if (priceId === s.priceProYearly)  return { plan: 'pro', period: 'yearly' };
  if (priceId === s.priceMaxMonthly) return { plan: 'max', period: 'monthly' };
  if (priceId === s.priceMaxYearly)  return { plan: 'max', period: 'yearly' };
  // BRL prices
  if (priceId === s.priceProMonthlyBrl) return { plan: 'pro', period: 'monthly' };
  if (priceId === s.priceProYearlyBrl)  return { plan: 'pro', period: 'yearly' };
  if (priceId === s.priceMaxMonthlyBrl) return { plan: 'max', period: 'monthly' };
  if (priceId === s.priceMaxYearlyBrl)  return { plan: 'max', period: 'yearly' };
  return { plan: 'pro', period: 'monthly' }; // fallback
}

// ── Singleton ───────────────────────────────────────────────────────

let stripeClient: StripeInstance | null = null;

function getStripe(): StripeInstance {
  if (!stripeClient) {
    if (!config.stripe.secretKey) {
      throw new Error('Stripe not configured (STRIPE_SECRET_KEY missing)');
    }
    stripeClient = new StripeLib(config.stripe.secretKey);
  }
  return stripeClient;
}

export function isStripeConfigured(): boolean {
  return !!(config.stripe.secretKey && config.stripe.webhookSecret);
}

// ── Subscription Status ─────────────────────────────────────────────

export function getSubscriptionStatus(userId: number): SubscriptionStatus {
  const db = getDb();
  const row = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId) as any;

  if (!row || row.status === 'inactive' || row.status === 'expired') {
    return {
      plan: 'free', period: 'monthly', status: 'inactive', provider: 'none',
      currentPeriodEnd: null, cancelAtPeriodEnd: false,
      isActive: false, isPro: false,
    };
  }

  const isActive = ['active', 'trialing'].includes(row.status);
  return {
    plan: row.plan,
    period: row.period,
    status: row.status,
    provider: row.provider,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: !!row.cancel_at_period_end,
    isActive,
    isPro: isActive && (row.plan === 'pro' || row.plan === 'max'),
  };
}

// ── Checkout Session ────────────────────────────────────────────────

export async function createCheckoutSession(
  userId: number,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const stripe = getStripe();

  // Look up existing Stripe customer for this user
  const db = getDb();
  const existing = db.prepare(
    "SELECT provider_customer_id FROM subscriptions WHERE user_id = ? AND provider = 'stripe'"
  ).get(userId) as { provider_customer_id: string } | undefined;

  const sessionParams: any = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { userId: String(userId) },
    subscription_data: {
      metadata: { userId: String(userId) },
    },
  };

  // Reuse existing Stripe customer if we have one
  if (existing?.provider_customer_id) {
    sessionParams.customer = existing.provider_customer_id;
  } else {
    sessionParams.customer_creation = 'always';
  }

  const session = await stripe.checkout.sessions.create(sessionParams);
  if (!session.url) throw new Error('Stripe returned no checkout URL');

  logger.info({ userId, priceId, sessionId: session.id }, 'Stripe checkout session created');
  return session.url;
}

// ── Customer Portal ─────────────────────────────────────────────────

export async function createPortalSession(userId: number, returnUrl: string): Promise<string> {
  const stripe = getStripe();
  const db = getDb();
  const row = db.prepare(
    "SELECT provider_customer_id FROM subscriptions WHERE user_id = ? AND provider = 'stripe'"
  ).get(userId) as { provider_customer_id: string } | undefined;

  if (!row?.provider_customer_id) {
    throw new Error('No Stripe customer found for this user');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: row.provider_customer_id,
    return_url: returnUrl,
  });

  return session.url;
}

// ── Webhook Handlers ────────────────────────────────────────────────

export function handleCheckoutCompleted(session: any): void {
  const userId = parseInt(session.metadata?.userId || '0', 10);
  if (!userId) {
    logger.warn({ sessionId: session.id }, 'Stripe checkout.session.completed missing userId metadata');
    return;
  }

  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id;
  const customerId = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id;

  if (!subscriptionId) {
    logger.warn({ sessionId: session.id }, 'checkout.session.completed with no subscription');
    return;
  }

  // We'll get the full subscription details from customer.subscription.updated
  // which fires right after checkout. For now, just store the IDs.
  const db = getDb();
  db.prepare(`
    INSERT INTO subscriptions (user_id, plan, period, status, provider, provider_subscription_id, provider_customer_id, updated_at)
    VALUES (?, 'pro', 'monthly', 'active', 'stripe', ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      provider = 'stripe',
      provider_subscription_id = excluded.provider_subscription_id,
      provider_customer_id = excluded.provider_customer_id,
      status = 'active',
      updated_at = datetime('now')
  `).run(userId, subscriptionId, customerId || null);

  logger.info({ userId, subscriptionId, customerId }, 'Stripe checkout completed — subscription activated');
}

export function handleSubscriptionUpdated(subscription: any): void {
  const userId = parseInt(subscription.metadata?.userId || '0', 10);
  if (!userId) {
    logger.warn({ subId: subscription.id }, 'subscription.updated missing userId metadata');
    return;
  }

  // Resolve plan from the first line item's price
  const priceId = subscription.items?.data?.[0]?.price?.id || '';
  const { plan, period } = resolvePlan(priceId);

  const status = subscription.status; // 'active', 'past_due', 'canceled', 'trialing', etc.
  const periodStart = subscription.current_period_start
    ? new Date(subscription.current_period_start * 1000).toISOString()
    : null;
  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;
  const cancelAtEnd = subscription.cancel_at_period_end ? 1 : 0;

  const db = getDb();
  db.prepare(`
    INSERT INTO subscriptions (user_id, plan, period, status, provider, provider_subscription_id, current_period_start, current_period_end, cancel_at_period_end, updated_at)
    VALUES (?, ?, ?, ?, 'stripe', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      plan = excluded.plan,
      period = excluded.period,
      status = excluded.status,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end,
      updated_at = datetime('now')
  `).run(userId, plan, period, status, subscription.id, periodStart, periodEnd, cancelAtEnd);

  logger.info({ userId, plan, period, status, subId: subscription.id }, 'Stripe subscription updated');
}

export function handleSubscriptionDeleted(subscription: any): void {
  const userId = parseInt(subscription.metadata?.userId || '0', 10);
  if (!userId) return;

  const db = getDb();
  db.prepare(`
    UPDATE subscriptions SET status = 'canceled', cancel_at_period_end = 1, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'stripe'
  `).run(userId);

  logger.info({ userId, subId: subscription.id }, 'Stripe subscription deleted/canceled');
}

export function handleInvoicePaymentFailed(invoice: any): void {
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;

  const db = getDb();
  db.prepare(`
    UPDATE subscriptions SET status = 'past_due', updated_at = datetime('now')
    WHERE provider_customer_id = ? AND provider = 'stripe'
  `).run(customerId);

  logger.warn({ customerId, invoiceId: invoice.id }, 'Stripe invoice payment failed — subscription past_due');
}

// ── Apple IAP Verification ──────────────────────────────────────────
// Called by POST /api/v1/billing/apple-verify when StoreKit 2 sends a
// signed JWS transaction. We decode the payload (trusting the Apple
// certificate chain) and UPSERT to the same subscriptions table.

export function handleAppleTransaction(
  userId: number,
  originalTransactionId: string,
  productId: string,
  expiresDate: string | null,
): void {
  const { plan, period } = resolveAppleProduct(productId);

  const db = getDb();
  db.prepare(`
    INSERT INTO subscriptions (user_id, plan, period, status, provider, provider_subscription_id, current_period_end, updated_at)
    VALUES (?, ?, ?, 'active', 'apple', ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      plan = excluded.plan,
      period = excluded.period,
      status = 'active',
      provider = 'apple',
      provider_subscription_id = excluded.provider_subscription_id,
      current_period_end = excluded.current_period_end,
      updated_at = datetime('now')
  `).run(userId, plan, period, originalTransactionId, expiresDate);

  logger.info({ userId, productId, originalTransactionId }, 'Apple IAP transaction verified — subscription active');
}

function resolveAppleProduct(productId: string): { plan: string; period: string } {
  if (productId.includes('max') && productId.includes('yearly'))  return { plan: 'max', period: 'yearly' };
  if (productId.includes('max'))                                   return { plan: 'max', period: 'monthly' };
  if (productId.includes('yearly'))                                return { plan: 'pro', period: 'yearly' };
  return { plan: 'pro', period: 'monthly' };
}
